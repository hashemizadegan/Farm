-- G3 (simulation cycles): carry-forward between consecutive cycles of one asset. Each calculation records what its
-- distribution plan took in (`ledger_in`) and carried out (`ledger_out`: the carried remainder and each party's
-- deferred dust), as canonical text with its SHA-256 (packages/domain yield/carry-ledger.ts), checked here.
--
-- Chaining (deterministic, one rule, used by the service and enforced here):
-- - a cycle's carry source is the approved artifact set of the latest published or closed **simulation** cycle of
--   the same tenant, business asset and chain asset whose period ends before this cycle's period starts (latest
--   period end, then highest version); no such cycle: no source, and the carry-in must be the empty ledger;
-- - the carry-in must hash to the source's recorded carry-out;
-- - a cycle in between that is still open (not published, closed, cancelled, abandoned or superseded) blocks the
--   chain: carry is consumed in order, never twice by two later periods;
-- - corrections (a new version of the same period) consume the same source; the superseded version drops out.
-- Append-only and immutable. Real cycles are refused. From this migration on, `calculate` also needs the set's carry
-- row. Nothing earlier is relaxed.

CREATE TABLE yield_carry_ledgers (
  id                 bigserial PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  cycle_id           uuid NOT NULL,
  artifact_set_id    uuid NOT NULL,
  -- The predecessor's approved artifact set whose carry-out this set took in; null for the first cycle.
  source_set_id      uuid REFERENCES yield_artifact_sets(id),
  ledger_in          text NOT NULL CHECK (length(ledger_in) BETWEEN 2 AND 20000000),
  ledger_in_sha256   text NOT NULL CHECK (ledger_in_sha256 ~ '^[0-9a-f]{64}$'),
  ledger_out         text NOT NULL CHECK (length(ledger_out) BETWEEN 2 AND 20000000),
  ledger_out_sha256  text NOT NULL CHECK (ledger_out_sha256 ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_set_id),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES yield_cycles(tenant_id, id),
  FOREIGN KEY (artifact_set_id, cycle_id) REFERENCES yield_artifact_sets(id, cycle_id),
  CONSTRAINT yield_carry_ledgers_in_hash CHECK (ledger_in_sha256 = encode(sha256(convert_to(ledger_in, 'UTF8')), 'hex')),
  CONSTRAINT yield_carry_ledgers_out_hash CHECK (ledger_out_sha256 = encode(sha256(convert_to(ledger_out, 'UTF8')), 'hex')),
  CONSTRAINT yield_carry_ledgers_genesis CHECK (source_set_id IS NOT NULL OR ledger_in = '{"carriedRemainder":"0","deferred":[]}')
);
CREATE INDEX yield_carry_ledgers_cycle_idx ON yield_carry_ledgers (tenant_id, cycle_id);
CREATE INDEX yield_carry_ledgers_source_idx ON yield_carry_ledgers (source_set_id);

-- The carry source of a cycle (see above), or null. Read-only; also used by the service.
CREATE FUNCTION yield_carry_source(p_cycle_id uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT s.id
    FROM yield_cycles c
    JOIN yield_cycles p ON p.tenant_id = c.tenant_id AND p.business_asset_id = c.business_asset_id
                       AND p.network = c.network AND p.rail = c.rail AND p.chain_asset_id = c.chain_asset_id
                       AND p.simulation AND p.status IN ('published', 'closed') AND p.period_end < c.period_start
    JOIN yield_artifact_sets s ON s.cycle_id = p.id AND s.status = 'approved'
   WHERE c.id = p_cycle_id
   ORDER BY p.period_end DESC, p.version DESC, p.id DESC
   LIMIT 1
$$;

CREATE FUNCTION yield_carry_ledgers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c yield_cycles%ROWTYPE; s yield_artifact_sets%ROWTYPE; want uuid; src yield_carry_ledgers%ROWTYPE; srcc yield_cycles%ROWTYPE;
BEGIN
  SELECT * INTO c FROM yield_cycles WHERE tenant_id = NEW.tenant_id AND id = NEW.cycle_id;
  SELECT * INTO s FROM yield_artifact_sets WHERE id = NEW.artifact_set_id;
  IF c.id IS NULL OR s.id IS NULL THEN
    RETURN NEW; -- the foreign keys refuse it
  END IF;
  IF NOT c.simulation THEN
    RAISE EXCEPTION 'carry-forward is recorded for simulation cycles only' USING ERRCODE = 'check_violation', HINT = 'yield:real_gate';
  END IF;
  IF c.status <> 'inputs_locked' OR s.status <> 'frozen' THEN
    RAISE EXCEPTION 'carry rows are added only while the cycle is calculated (cycle %, set %)', c.status, s.status USING ERRCODE = 'check_violation', HINT = 'yield:not_calculating';
  END IF;
  want := yield_carry_source(NEW.cycle_id);
  IF NEW.source_set_id IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'the carry source is not this cycle''s predecessor (expected %)', want USING ERRCODE = 'check_violation', HINT = 'yield:carry_source_mismatch';
  END IF;
  IF want IS NOT NULL THEN
    SELECT * INTO src FROM yield_carry_ledgers WHERE artifact_set_id = want;
    IF src.id IS NULL THEN
      RAISE EXCEPTION 'the predecessor set % has no recorded carry-out', want USING ERRCODE = 'check_violation', HINT = 'yield:carry_source_missing';
    END IF;
    IF NEW.ledger_in_sha256 IS DISTINCT FROM src.ledger_out_sha256 THEN
      RAISE EXCEPTION 'the carry-in is not the predecessor''s carry-out' USING ERRCODE = 'check_violation', HINT = 'yield:carry_mismatch';
    END IF;
    SELECT p.* INTO srcc FROM yield_cycles p JOIN yield_artifact_sets ps ON ps.cycle_id = p.id WHERE ps.id = want;
    -- Carry is consumed in order: no open cycle of the asset between the predecessor and this one.
    IF EXISTS (SELECT 1 FROM yield_cycles m
                WHERE m.tenant_id = c.tenant_id AND m.business_asset_id = c.business_asset_id AND m.network = c.network AND m.rail = c.rail
                  AND m.chain_asset_id = c.chain_asset_id AND m.simulation AND m.id <> c.id
                  AND m.period_start > srcc.period_end AND m.period_end < c.period_start
                  AND m.status NOT IN ('published', 'closed', 'cancelled', 'abandoned', 'superseded')) THEN
      RAISE EXCEPTION 'an earlier cycle of this asset is still open: carry is consumed in order' USING ERRCODE = 'check_violation', HINT = 'yield:carry_predecessor_open';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yield_carry_ledgers_guard BEFORE INSERT ON yield_carry_ledgers FOR EACH ROW EXECUTE FUNCTION yield_carry_ledgers_guard();
CREATE TRIGGER yield_carry_ledgers_append_only BEFORE UPDATE OR DELETE ON yield_carry_ledgers FOR EACH ROW EXECUTE FUNCTION append_only();

-- `calculate` also records the set's carry row (after yield_cycles_require_frozen_artifact, by name).
CREATE FUNCTION yield_cycles_require_carry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'inputs_locked' AND NEW.status = 'calculated' AND NOT EXISTS (
       SELECT 1 FROM yield_carry_ledgers l JOIN yield_artifact_sets s ON s.id = l.artifact_set_id
        WHERE s.cycle_id = NEW.id AND s.status = 'frozen' AND s.set_hash = NEW.artifact_set_hash) THEN
    RAISE EXCEPTION 'calculate needs the set''s carry-forward record' USING ERRCODE = 'check_violation', HINT = 'yield:carry_missing';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yield_cycles_require_zcarry BEFORE UPDATE ON yield_cycles FOR EACH ROW EXECUTE FUNCTION yield_cycles_require_carry();

ALTER TABLE yield_carry_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE yield_carry_ledgers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON yield_carry_ledgers TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON yield_carry_ledgers TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON yield_carry_ledgers TO metafarm_app;
GRANT USAGE ON SEQUENCE yield_carry_ledgers_id_seq TO metafarm_app;
GRANT EXECUTE ON FUNCTION yield_carry_source(uuid) TO metafarm_app;
