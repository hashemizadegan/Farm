-- Y7 (real-yield plan §7.2): the core yield schema. Cycles with a database-enforced state machine,
-- append-only transition log, frozen artifact sets, ownership snapshots with database-level fixture
-- exclusion (D-17, layer 2), allocations, attestations, evidence metadata and input lines.
--
-- Decisions applied:
-- - D-31 (documented recommendation, adopted under the owner's standing instruction; not a sign-off): who did
--   what goes to the existing audit_events (0001); state history goes to the append-only yield_cycle_transitions.
-- - D-17 (owner-approved 2026-10-22): fixture ownership never in a non-simulation cycle, enforced here by a
--   trigger joining yield_cycles.simulation; Y5 already refuses it in the service layer.
-- Fail-closed choices (no decision recorded; the most conservative option, see the handoff):
-- - A non-simulation cycle cannot go past inputs_locked: every Real gate of plan §2.1 is open. Lifting this needs
--   a migration recorded with those approvals.
-- - Evidence rows must be simulation-labelled until D-24 (retention) is approved.
-- - Future phases (fund, distribute) cannot be entered: the states exist in the plan, but no transition here
--   leads to them.
-- Deliberately not here (later stages): reserves, policies, FX rates (Y9, with approved policy records), Merkle
-- trees and leaves (Y6 final, D-26), claims (Y13), reconciliations, disputes and corrections records (Y9/Y14).
-- Nothing is destructive: no existing table or audit record is altered.
-- Every refusal raised here carries a stable code in its HINT ('yield:<code>'), read by packages/db yield.ts.

-- ── Cycles ──────────────────────────────────────────────────────────────

CREATE TABLE yield_cycles (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  business_asset_id    uuid NOT NULL,
  period_start         date NOT NULL,
  period_end           date NOT NULL,
  version              integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  -- Simulation by default (plan §12.1): a real cycle has to be asked for explicitly.
  simulation           boolean NOT NULL DEFAULT true,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN (
                         'draft', 'inputs_locked', 'calculated', 'under_review', 'approved', 'published',
                         'funded', 'distributing', 'disputed', 'closed', 'cancelled', 'abandoned', 'superseded')),
  -- The state a disputed cycle returns to on `dismiss`.
  prior_status         text CHECK (prior_status IN ('published', 'funded', 'distributing')),
  close_reason         text CHECK (close_reason IN ('no_distribution', 'loss', 'unfunded', 'simulation', 'distributed')),
  -- The chain identity whose ownership is allocated (one asset per cycle, plan §11.1 Y5).
  network              text NOT NULL CHECK (network IN ('solana-devnet', 'solana-mainnet')),
  rail                 text NOT NULL CHECK (rail IN ('SOLANA_TOKEN_2022', 'SOLANA_BUBBLEGUM_CNFT')),
  chain_asset_id       text NOT NULL CHECK (chain_asset_id ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Versions and hashes of what the cycle is calculated under (plan §3.8). Hashes are lowercase SHA-256 hex.
  entitlement_ref      text CHECK (entitlement_ref ~ '^[0-9a-f]{64}$'),
  policy_hash          text CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  formula_version      text CHECK (formula_version ~ '^[a-z0-9][a-z0-9._:/\-]{0,63}$'),
  accounting_currency  text CHECK (accounting_currency ~ '^[A-Z]{3}$'),
  settlement_mint      text CHECK (settlement_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  settlement_decimals  smallint CHECK (settlement_decimals BETWEEN 0 AND 18),
  -- The eligible slot range (start, end], fixed at `calculate` (plan §2.2).
  slot_start           bigint CHECK (slot_start >= 0),
  slot_end             bigint,
  -- Set by the trigger at `calculate`; cleared (and the set invalidated) by `unlock` or `reject`.
  artifact_set_hash    text CHECK (artifact_set_hash ~ '^[0-9a-f]{64}$'),
  merkle_root          text CHECK (merkle_root ~ '^[0-9a-f]{64}$'),
  -- Who ran `calculate`; `approve` must be someone else (four-eyes, as rwa_orders_four_eyes).
  prepared_by          uuid REFERENCES users(id),
  -- The actor and reason of a transition, set in the same UPDATE as the status; the trigger copies them into
  -- yield_cycle_transitions and clears them, so a transition can never inherit the previous one's actor.
  status_changed_by    uuid REFERENCES users(id),
  status_reason        text CHECK (length(status_reason) BETWEEN 1 AND 2000),
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, business_asset_id, period_start, period_end, version),
  FOREIGN KEY (tenant_id, business_asset_id) REFERENCES business_assets(tenant_id, id) ON DELETE RESTRICT,
  CHECK (period_end >= period_start),
  CHECK (slot_end IS NULL OR (slot_start IS NOT NULL AND slot_end > slot_start AND slot_end - slot_start <= 4294967296)),
  CHECK ((status = 'closed') = (close_reason IS NOT NULL)),
  CHECK (close_reason IS DISTINCT FROM 'simulation' OR simulation),
  CHECK ((status = 'disputed') = (prior_status IS NOT NULL)),
  CHECK ((artifact_set_hash IS NULL) = (status IN ('draft', 'inputs_locked', 'cancelled', 'abandoned')) OR status IN ('cancelled', 'abandoned')),
  -- Future phases are never entered here (separate funding and execution approval, plan §6.3).
  CONSTRAINT yield_cycles_no_future_phase CHECK (status NOT IN ('funded', 'distributing')),
  -- Fail closed: a non-simulation cycle stops at inputs_locked until the Real gates of plan §2.1 are approved.
  CONSTRAINT yield_cycles_real_gate CHECK (simulation OR status IN ('draft', 'inputs_locked', 'cancelled', 'abandoned'))
);
CREATE INDEX yield_cycles_status_idx ON yield_cycles (tenant_id, status, created_at);
CREATE INDEX yield_cycles_asset_idx ON yield_cycles (tenant_id, business_asset_id);

-- Allowed state changes in the current phase (mirrors YIELD_TRANSITIONS of packages/domain yield/cycle.ts, Y1,
-- without the future ones; `dismiss` returns to prior_status). Returns the command, or NULL when refused.
CREATE FUNCTION yield_cycle_command(from_state text, to_state text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT c FROM (VALUES
      ('draft', 'inputs_locked', 'lock'),
      ('inputs_locked', 'draft', 'unlock'),
      ('calculated', 'inputs_locked', 'unlock'),
      ('inputs_locked', 'calculated', 'calculate'),
      ('calculated', 'under_review', 'submit'),
      ('under_review', 'inputs_locked', 'reject'),
      ('under_review', 'approved', 'approve'),
      ('approved', 'published', 'publish'),
      ('draft', 'cancelled', 'cancel'), ('inputs_locked', 'cancelled', 'cancel'), ('calculated', 'cancelled', 'cancel'),
      ('under_review', 'cancelled', 'cancel'), ('approved', 'cancelled', 'cancel'),
      ('draft', 'abandoned', 'expire'), ('inputs_locked', 'abandoned', 'expire'), ('calculated', 'abandoned', 'expire'),
      ('under_review', 'abandoned', 'expire'), ('approved', 'abandoned', 'expire'),
      ('published', 'closed', 'close'),
      ('published', 'disputed', 'dispute'),
      ('disputed', 'published', 'dismiss'),
      ('published', 'superseded', 'supersede'),
      ('disputed', 'superseded', 'supersede')
  ) AS t(f, s, c) WHERE f = from_state AND s = to_state
$$;

CREATE TABLE yield_cycle_transitions (
  id                 bigserial PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  cycle_id           uuid NOT NULL,
  command            text NOT NULL,
  from_state         text,
  to_state           text NOT NULL,
  actor_user_id      uuid REFERENCES users(id),
  reason             text,
  artifact_set_hash  text,
  at                 timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES yield_cycles(tenant_id, id)
);
CREATE INDEX yield_cycle_transitions_cycle_idx ON yield_cycle_transitions (tenant_id, cycle_id, id);
CREATE TRIGGER yield_cycle_transitions_append_only BEFORE UPDATE OR DELETE ON yield_cycle_transitions
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- ── Artifact sets ───────────────────────────────────────────────────────

CREATE TABLE yield_artifact_sets (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  cycle_id               uuid NOT NULL,
  set_number             integer NOT NULL CHECK (set_number >= 1),
  status                 text NOT NULL DEFAULT 'frozen' CHECK (status IN ('frozen', 'invalidated', 'approved', 'superseded')),
  calculation_hash       text NOT NULL CHECK (calculation_hash ~ '^[0-9a-f]{64}$'),
  allocation_hash        text NOT NULL CHECK (allocation_hash ~ '^[0-9a-f]{64}$'),
  evidence_bundle_hash   text NOT NULL CHECK (evidence_bundle_hash ~ '^[0-9a-f]{64}$'),
  merkle_root            text NOT NULL CHECK (merkle_root ~ '^[0-9a-f]{64}$'),
  -- The hash attested to and approved: over the four hashes above (computed by the service).
  set_hash               text NOT NULL CHECK (set_hash ~ '^[0-9a-f]{64}$'),
  created_by             uuid NOT NULL REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (id, cycle_id),
  UNIQUE (cycle_id, set_number),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES yield_cycles(tenant_id, id)
);
-- At most one live (frozen or approved) set per cycle.
CREATE UNIQUE INDEX yield_artifact_sets_live_idx ON yield_artifact_sets (cycle_id) WHERE status IN ('frozen', 'approved');

-- Only the status moves, and only frozen → invalidated | approved, approved → superseded. Never deleted. The
-- application role has no UPDATE on this table: only the cycle trigger moves a set's status.
CREATE FUNCTION yield_artifact_sets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'yield artifact sets are never deleted' USING ERRCODE = 'insufficient_privilege', HINT = 'yield:immutable';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.cycle_id, NEW.set_number, NEW.calculation_hash, NEW.allocation_hash, NEW.evidence_bundle_hash,
      NEW.merkle_root, NEW.set_hash, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.cycle_id, OLD.set_number, OLD.calculation_hash, OLD.allocation_hash, OLD.evidence_bundle_hash,
      OLD.merkle_root, OLD.set_hash, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a yield artifact set is immutable' USING ERRCODE = 'check_violation', HINT = 'yield:immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN
     (('frozen', 'invalidated'), ('frozen', 'approved'), ('approved', 'superseded')) THEN
    RAISE EXCEPTION 'a yield artifact set cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'yield:invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yield_artifact_sets_guard BEFORE UPDATE OR DELETE ON yield_artifact_sets
  FOR EACH ROW EXECUTE FUNCTION yield_artifact_sets_guard();

-- A set is added only while its cycle is being calculated (inputs_locked), as status frozen.
CREATE FUNCTION yield_artifact_sets_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM yield_cycles WHERE tenant_id = NEW.tenant_id AND id = NEW.cycle_id;
  IF s IS DISTINCT FROM 'inputs_locked' OR NEW.status <> 'frozen' THEN
    RAISE EXCEPTION 'an artifact set is added as frozen to an inputs_locked cycle (cycle is %)', s USING ERRCODE = 'check_violation', HINT = 'yield:not_calculating';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yield_artifact_sets_insert_guard BEFORE INSERT ON yield_artifact_sets
  FOR EACH ROW EXECUTE FUNCTION yield_artifact_sets_insert_guard();

-- ── Ownership snapshots (D-17 layer 2) ─────────────────────────────────

CREATE TABLE yield_ownership_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  cycle_id            uuid NOT NULL,
  artifact_set_id     uuid NOT NULL,
  source_kind         text NOT NULL CHECK (source_kind IN ('rpc', 'fixture')),
  -- The verified cluster identity (Y0) of an RPC snapshot; fixture snapshots have none.
  source_identity_id  bigint,
  network             text NOT NULL CHECK (network IN ('solana-devnet', 'solana-mainnet')),
  rail                text NOT NULL CHECK (rail IN ('SOLANA_TOKEN_2022', 'SOLANA_BUBBLEGUM_CNFT')),
  chain_asset_id      text NOT NULL,
  slot_start          bigint NOT NULL CHECK (slot_start >= 0),
  slot_end            bigint NOT NULL,
  cursor_slot         bigint NOT NULL,
  holding_model       text NOT NULL CHECK (holding_model IN ('slot_weighted')),
  -- The Y5 WeightedOwnershipInput commitment (metafarm-weighted-ownership/1).
  input_commitment    text NOT NULL CHECK (input_commitment ~ '^[0-9a-f]{64}$'),
  total_weight        numeric(78, 0) NOT NULL CHECK (total_weight > 0 AND total_weight <= 340282366920938463463374607431768211455),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (artifact_set_id),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES yield_cycles(tenant_id, id),
  FOREIGN KEY (artifact_set_id, cycle_id) REFERENCES yield_artifact_sets(id, cycle_id),
  FOREIGN KEY (source_identity_id, network) REFERENCES ownership_source_identities(id, network),
  CHECK (slot_end > slot_start AND cursor_slot >= slot_end),
  CONSTRAINT yield_ownership_snapshots_source_identity CHECK ((source_kind = 'rpc') = (source_identity_id IS NOT NULL))
);
CREATE INDEX yield_ownership_snapshots_cycle_idx ON yield_ownership_snapshots (tenant_id, cycle_id);
CREATE INDEX yield_ownership_snapshots_identity_idx ON yield_ownership_snapshots (source_identity_id);

CREATE FUNCTION yield_ownership_snapshots_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c yield_cycles%ROWTYPE;
BEGIN
  SELECT * INTO c FROM yield_cycles WHERE tenant_id = NEW.tenant_id AND id = NEW.cycle_id;
  -- D-17: fixture ownership never in a non-simulation cycle.
  IF NEW.source_kind = 'fixture' AND NOT c.simulation THEN
    RAISE EXCEPTION 'fixture ownership cannot be used by a non-simulation cycle' USING ERRCODE = 'check_violation', HINT = 'yield:fixture_in_real_cycle';
  END IF;
  IF c.status <> 'inputs_locked' THEN
    RAISE EXCEPTION 'an ownership snapshot is taken while the cycle is calculated (cycle is %)', c.status USING ERRCODE = 'check_violation', HINT = 'yield:not_calculating';
  END IF;
  IF (NEW.network, NEW.rail, NEW.chain_asset_id) IS DISTINCT FROM (c.network, c.rail, c.chain_asset_id) THEN
    RAISE EXCEPTION 'the snapshot is of another asset than the cycle' USING ERRCODE = 'check_violation', HINT = 'yield:snapshot_mismatch';
  END IF;
  IF (NEW.slot_start, NEW.slot_end) IS DISTINCT FROM (c.slot_start, c.slot_end) THEN
    RAISE EXCEPTION 'the snapshot slot range differs from the cycle''s' USING ERRCODE = 'check_violation', HINT = 'yield:snapshot_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yield_ownership_snapshots_guard BEFORE INSERT ON yield_ownership_snapshots
  FOR EACH ROW EXECUTE FUNCTION yield_ownership_snapshots_guard();
CREATE TRIGGER yield_ownership_snapshots_append_only BEFORE UPDATE OR DELETE ON yield_ownership_snapshots
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- ── Allocations ─────────────────────────────────────────────────────────

CREATE TABLE yield_allocations (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  cycle_id         uuid NOT NULL,
  artifact_set_id  uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('allocated', 'unattributed', 'withheld', 'dust')),
  party_id         uuid,
  -- An unattributed holder (a wallet address with no registered party).
  holder_key       text CHECK (holder_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  weight           numeric(78, 0) NOT NULL CHECK (weight >= 0 AND weight <= 340282366920938463463374607431768211455),
  -- Settlement minor units; a leaf amount must fit u64 (checked again at the leaf, Y6).
  amount           numeric(78, 0) NOT NULL CHECK (amount >= 0 AND amount <= 18446744073709551615),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES yield_cycles(tenant_id, id),
  FOREIGN KEY (artifact_set_id, cycle_id) REFERENCES yield_artifact_sets(id, cycle_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  CHECK ((kind IN ('allocated', 'withheld')) = (party_id IS NOT NULL)),
  CHECK ((kind = 'unattributed') = (holder_key IS NOT NULL))
);
-- One row per party per set (no double allocation), one per unattributed holder, one dust row.
CREATE UNIQUE INDEX yield_allocations_party_idx ON yield_allocations (artifact_set_id, party_id) WHERE party_id IS NOT NULL;
CREATE UNIQUE INDEX yield_allocations_holder_idx ON yield_allocations (artifact_set_id, holder_key) WHERE holder_key IS NOT NULL;
CREATE UNIQUE INDEX yield_allocations_dust_idx ON yield_allocations (artifact_set_id) WHERE kind = 'dust';
CREATE INDEX yield_allocations_cycle_idx ON yield_allocations (tenant_id, cycle_id);

CREATE FUNCTION yield_rows_during_calculate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c text; s text;
BEGIN
  SELECT status INTO c FROM yield_cycles WHERE tenant_id = NEW.tenant_id AND id = NEW.cycle_id;
  SELECT status INTO s FROM yield_artifact_sets WHERE id = NEW.artifact_set_id;
  IF c IS DISTINCT FROM 'inputs_locked' OR s IS DISTINCT FROM 'frozen' THEN
    RAISE EXCEPTION '% rows are added only while the cycle is calculated (cycle %, set %)', TG_TABLE_NAME, c, s USING ERRCODE = 'check_violation', HINT = 'yield:not_calculating';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yield_allocations_guard BEFORE INSERT ON yield_allocations
  FOR EACH ROW EXECUTE FUNCTION yield_rows_during_calculate();
CREATE TRIGGER yield_allocations_append_only BEFORE UPDATE OR DELETE ON yield_allocations
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- ── Attestations ────────────────────────────────────────────────────────

CREATE TABLE yield_attestations (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  artifact_set_id   uuid NOT NULL,
  attester_user_id  uuid NOT NULL REFERENCES users(id),
  -- A revocation is a new row, never an edit.
  kind              text NOT NULL CHECK (kind IN ('attest', 'revoke')),
  attested_hash     text NOT NULL CHECK (attested_hash ~ '^[0-9a-f]{64}$'),
  statement         text NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, artifact_set_id) REFERENCES yield_artifact_sets(tenant_id, id),
  UNIQUE (artifact_set_id, attester_user_id, kind)
);
CREATE INDEX yield_attestations_set_idx ON yield_attestations (tenant_id, artifact_set_id);

CREATE FUNCTION yield_attestations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s yield_artifact_sets%ROWTYPE;
BEGIN
  SELECT * INTO s FROM yield_artifact_sets WHERE tenant_id = NEW.tenant_id AND id = NEW.artifact_set_id;
  IF NEW.attested_hash IS DISTINCT FROM s.set_hash THEN
    RAISE EXCEPTION 'the attestation is not of this artifact set''s hash' USING ERRCODE = 'check_violation', HINT = 'yield:attestation_mismatch';
  END IF;
  IF s.status <> 'frozen' THEN
    RAISE EXCEPTION 'only a frozen artifact set is attested (set is %)', s.status USING ERRCODE = 'check_violation', HINT = 'yield:attestation_mismatch';
  END IF;
  IF NEW.kind = 'revoke' AND NOT EXISTS (SELECT 1 FROM yield_attestations a WHERE a.artifact_set_id = NEW.artifact_set_id AND a.attester_user_id = NEW.attester_user_id AND a.kind = 'attest') THEN
    RAISE EXCEPTION 'nothing to revoke' USING ERRCODE = 'check_violation', HINT = 'yield:attestation_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yield_attestations_guard BEFORE INSERT ON yield_attestations
  FOR EACH ROW EXECUTE FUNCTION yield_attestations_guard();
CREATE TRIGGER yield_attestations_append_only BEFORE UPDATE OR DELETE ON yield_attestations
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- ── Evidence metadata and input lines ───────────────────────────────────

CREATE TABLE yield_evidence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  content_sha256    text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_type     text NOT NULL CHECK (evidence_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  classification    text NOT NULL CHECK (classification IN ('public', 'internal', 'confidential', 'personal')),
  -- Until D-24 (retention) is approved, only simulation evidence may be registered (plan §11.1 Y4).
  simulation        boolean NOT NULL DEFAULT true CONSTRAINT yield_evidence_simulation_only CHECK (simulation),
  supersedes        uuid,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_sha256, evidence_type),
  FOREIGN KEY (tenant_id, supersedes) REFERENCES yield_evidence(tenant_id, id)
);
CREATE TRIGGER yield_evidence_append_only BEFORE UPDATE OR DELETE ON yield_evidence
  FOR EACH ROW EXECUTE FUNCTION append_only();

CREATE TABLE yield_inputs (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  cycle_id          uuid NOT NULL,
  side              text NOT NULL CHECK (side IN ('revenue', 'expense')),
  kind              text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- Accounting-currency minor units.
  amount            numeric(78, 0) NOT NULL CHECK (amount >= 0),
  currency          text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  completeness      text NOT NULL CHECK (completeness IN ('known', 'zero', 'estimated')),
  evidence_id       uuid,
  -- Where the line comes from (an invoice, a harvest batch …): one source counts once.
  source_kind       text NOT NULL CHECK (source_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  source_ref        text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES yield_cycles(tenant_id, id),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES yield_evidence(tenant_id, id),
  UNIQUE (cycle_id, source_kind, source_ref),
  CHECK (completeness <> 'zero' OR amount = 0)
);
CREATE INDEX yield_inputs_cycle_idx ON yield_inputs (tenant_id, cycle_id);
CREATE INDEX yield_inputs_source_idx ON yield_inputs (tenant_id, source_kind, source_ref);

CREATE FUNCTION yield_inputs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c yield_cycles%ROWTYPE; ev boolean;
BEGIN
  SELECT * INTO c FROM yield_cycles WHERE tenant_id = NEW.tenant_id AND id = NEW.cycle_id;
  IF c.status <> 'draft' THEN
    RAISE EXCEPTION 'input lines are added to a draft cycle (cycle is %)', c.status USING ERRCODE = 'check_violation', HINT = 'yield:cycle_not_draft';
  END IF;
  -- Simulation records are never referenced by a non-simulation cycle.
  IF NEW.evidence_id IS NOT NULL THEN
    SELECT simulation INTO ev FROM yield_evidence WHERE tenant_id = NEW.tenant_id AND id = NEW.evidence_id;
    IF ev AND NOT c.simulation THEN
      RAISE EXCEPTION 'simulation evidence cannot be used by a non-simulation cycle' USING ERRCODE = 'check_violation', HINT = 'yield:simulation_record_in_real_cycle';
    END IF;
  END IF;
  -- No double counting: a source already counted by another live non-simulation cycle is refused.
  IF NOT c.simulation AND EXISTS (
       SELECT 1 FROM yield_inputs i JOIN yield_cycles o ON o.tenant_id = i.tenant_id AND o.id = i.cycle_id
        WHERE i.tenant_id = NEW.tenant_id AND i.source_kind = NEW.source_kind AND i.source_ref = NEW.source_ref
          AND i.cycle_id <> NEW.cycle_id AND NOT o.simulation AND o.status NOT IN ('cancelled', 'abandoned', 'superseded')) THEN
    RAISE EXCEPTION 'source %/% is already counted by another live cycle', NEW.source_kind, NEW.source_ref USING ERRCODE = 'unique_violation', HINT = 'yield:double_counted';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yield_inputs_guard BEFORE INSERT ON yield_inputs
  FOR EACH ROW EXECUTE FUNCTION yield_inputs_guard();
CREATE TRIGGER yield_inputs_append_only BEFORE UPDATE OR DELETE ON yield_inputs
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- ── The cycle guard: state machine, frozen columns, four-eyes, transition log ──

-- SECURITY DEFINER so it can write the transition log and move artifact-set status, which the application
-- role cannot do directly.
CREATE FUNCTION yield_cycles_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cmd text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'yield cycles are never deleted' USING ERRCODE = 'insufficient_privilege', HINT = 'yield:immutable';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.artifact_set_hash IS NOT NULL OR NEW.merkle_root IS NOT NULL OR NEW.prepared_by IS NOT NULL THEN
      RAISE EXCEPTION 'a yield cycle starts as an empty draft' USING ERRCODE = 'check_violation', HINT = 'yield:invalid_create';
    END IF;
    RETURN NEW; -- logged by yield_cycles_created (AFTER INSERT: the row must exist for the log's foreign key)
  END IF;

  -- Identity never changes.
  IF (NEW.id, NEW.tenant_id, NEW.business_asset_id, NEW.period_start, NEW.period_end, NEW.version, NEW.simulation,
      NEW.network, NEW.rail, NEW.chain_asset_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.business_asset_id, OLD.period_start, OLD.period_end, OLD.version, OLD.simulation,
      OLD.network, OLD.rail, OLD.chain_asset_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'yield cycle identity is fixed' USING ERRCODE = 'check_violation', HINT = 'yield:immutable';
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    -- No status change: only the calculation parameters, and only before calculation.
    IF OLD.status NOT IN ('draft', 'inputs_locked') THEN
      RAISE EXCEPTION 'a % yield cycle is frozen', OLD.status USING ERRCODE = 'check_violation', HINT = 'yield:frozen';
    END IF;
    IF (NEW.artifact_set_hash, NEW.merkle_root, NEW.prepared_by, NEW.prior_status, NEW.close_reason, NEW.status_changed_by, NEW.status_reason)
       IS DISTINCT FROM (OLD.artifact_set_hash, OLD.merkle_root, OLD.prepared_by, OLD.prior_status, OLD.close_reason, OLD.status_changed_by, OLD.status_reason) THEN
      RAISE EXCEPTION 'calculation results are set only by a transition' USING ERRCODE = 'check_violation', HINT = 'yield:frozen';
    END IF;
    -- The inputs are fixed at lock; the slot range may still be set while inputs_locked.
    IF OLD.status = 'inputs_locked' AND (NEW.entitlement_ref, NEW.policy_hash, NEW.formula_version, NEW.accounting_currency, NEW.settlement_mint, NEW.settlement_decimals)
       IS DISTINCT FROM (OLD.entitlement_ref, OLD.policy_hash, OLD.formula_version, OLD.accounting_currency, OLD.settlement_mint, OLD.settlement_decimals) THEN
      RAISE EXCEPTION 'cycle inputs are locked' USING ERRCODE = 'check_violation', HINT = 'yield:frozen';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NEW.status IN ('funded', 'distributing') THEN
    RAISE EXCEPTION 'funding and distribution need separate approval (plan §6.3)' USING ERRCODE = 'check_violation', HINT = 'yield:future_phase';
  END IF;
  cmd := yield_cycle_command(OLD.status, NEW.status);
  IF cmd IS NULL THEN
    RAISE EXCEPTION 'a yield cycle cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'yield:invalid_transition';
  END IF;
  -- Every transition but the system's `expire` names a user (the repository sets the actor on each transition).
  IF NEW.status_changed_by IS NULL AND cmd <> 'expire' THEN
    RAISE EXCEPTION 'a yield cycle transition names its actor' USING ERRCODE = 'check_violation', HINT = 'yield:actor_required';
  END IF;
  -- Parameters do not change in the same statement as a transition.
  IF (NEW.entitlement_ref, NEW.policy_hash, NEW.formula_version, NEW.accounting_currency, NEW.settlement_mint, NEW.settlement_decimals, NEW.slot_start, NEW.slot_end)
     IS DISTINCT FROM (OLD.entitlement_ref, OLD.policy_hash, OLD.formula_version, OLD.accounting_currency, OLD.settlement_mint, OLD.settlement_decimals, OLD.slot_start, OLD.slot_end) THEN
    RAISE EXCEPTION 'cycle parameters do not change during a transition' USING ERRCODE = 'check_violation', HINT = 'yield:frozen';
  END IF;

  IF cmd = 'lock' THEN
    IF NEW.entitlement_ref IS NULL OR NEW.policy_hash IS NULL OR NEW.formula_version IS NULL OR NEW.accounting_currency IS NULL
       OR NEW.settlement_mint IS NULL OR NEW.settlement_decimals IS NULL THEN
      RAISE EXCEPTION 'lock needs the entitlement reference, policy, formula, currency and settlement unit' USING ERRCODE = 'check_violation', HINT = 'yield:lock_incomplete';
    END IF;
  ELSIF cmd = 'calculate' THEN
    IF NEW.slot_start IS NULL OR NEW.slot_end IS NULL THEN
      RAISE EXCEPTION 'calculate needs the slot range' USING ERRCODE = 'check_violation', HINT = 'yield:calculation_incomplete';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM yield_artifact_sets s JOIN yield_ownership_snapshots o ON o.artifact_set_id = s.id
                    WHERE s.cycle_id = NEW.id AND s.status = 'frozen' AND s.set_hash = NEW.artifact_set_hash AND s.merkle_root = NEW.merkle_root) THEN
      RAISE EXCEPTION 'calculate needs a frozen artifact set with an ownership snapshot, matching the cycle''s hashes' USING ERRCODE = 'check_violation', HINT = 'yield:calculation_incomplete';
    END IF;
    NEW.prepared_by := NEW.status_changed_by;
  ELSIF cmd IN ('unlock', 'reject') AND OLD.status IN ('calculated', 'under_review') THEN
    UPDATE yield_artifact_sets SET status = 'invalidated' WHERE cycle_id = NEW.id AND status = 'frozen';
    NEW.artifact_set_hash := NULL;
    NEW.merkle_root := NULL;
    NEW.prepared_by := NULL;
  ELSIF cmd = 'approve' THEN
    IF NEW.status_changed_by IS NOT DISTINCT FROM OLD.prepared_by OR NEW.status_changed_by IS NOT DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'four-eyes: the approver cannot be the preparer' USING ERRCODE = 'check_violation', HINT = 'yield:four_eyes';
    END IF;
    UPDATE yield_artifact_sets SET status = 'approved' WHERE cycle_id = NEW.id AND status = 'frozen' AND set_hash = OLD.artifact_set_hash;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the frozen artifact set changed since calculation' USING ERRCODE = 'check_violation', HINT = 'yield:artifact_set_changed';
    END IF;
  ELSIF cmd = 'publish' THEN
    IF NOT EXISTS (SELECT 1 FROM yield_artifact_sets WHERE cycle_id = NEW.id AND status = 'approved' AND set_hash = OLD.artifact_set_hash) THEN
      RAISE EXCEPTION 'the approved artifact set changed' USING ERRCODE = 'check_violation', HINT = 'yield:artifact_set_changed';
    END IF;
  ELSIF cmd = 'close' THEN
    IF NEW.close_reason = 'distributed' THEN
      RAISE EXCEPTION 'distributed is a future-phase close reason' USING ERRCODE = 'check_violation', HINT = 'yield:future_phase';
    END IF;
  ELSIF cmd = 'dispute' THEN
    NEW.prior_status := OLD.status;
  ELSIF cmd = 'dismiss' THEN
    IF NEW.status IS DISTINCT FROM OLD.prior_status THEN
      RAISE EXCEPTION 'dismiss returns to %', OLD.prior_status USING ERRCODE = 'check_violation', HINT = 'yield:invalid_transition';
    END IF;
    NEW.prior_status := NULL;
  ELSIF cmd = 'supersede' THEN
    NEW.prior_status := NULL;
    UPDATE yield_artifact_sets SET status = 'superseded' WHERE cycle_id = NEW.id AND status = 'approved';
  ELSIF cmd IN ('cancel', 'expire') THEN
    UPDATE yield_artifact_sets SET status = 'invalidated' WHERE cycle_id = NEW.id AND status = 'frozen';
  END IF;
  IF cmd <> 'calculate' AND (NEW.artifact_set_hash, NEW.merkle_root) IS DISTINCT FROM (OLD.artifact_set_hash, OLD.merkle_root)
     AND NOT (cmd IN ('unlock', 'reject') AND OLD.status IN ('calculated', 'under_review')) THEN
    RAISE EXCEPTION 'calculation results are set only by calculate' USING ERRCODE = 'check_violation', HINT = 'yield:frozen';
  END IF;
  IF cmd <> 'close' AND NEW.close_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a close reason is set only by close' USING ERRCODE = 'check_violation', HINT = 'yield:invalid_transition';
  END IF;

  INSERT INTO yield_cycle_transitions (tenant_id, cycle_id, command, from_state, to_state, actor_user_id, reason, artifact_set_hash)
    VALUES (NEW.tenant_id, NEW.id, cmd, OLD.status, NEW.status, NEW.status_changed_by, NEW.status_reason, COALESCE(NEW.artifact_set_hash, OLD.artifact_set_hash));
  -- The actor and reason belong to this transition only (kept in the log): the next one must name its own.
  NEW.status_changed_by := NULL;
  NEW.status_reason := NULL;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER yield_cycles_guard BEFORE INSERT OR UPDATE OR DELETE ON yield_cycles
  FOR EACH ROW EXECUTE FUNCTION yield_cycles_guard();

CREATE FUNCTION yield_cycles_created() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO yield_cycle_transitions (tenant_id, cycle_id, command, from_state, to_state, actor_user_id, reason)
    VALUES (NEW.tenant_id, NEW.id, 'create', NULL, 'draft', NEW.created_by, NEW.status_reason);
  RETURN NULL;
END $$;
CREATE TRIGGER yield_cycles_created AFTER INSERT ON yield_cycles
  FOR EACH ROW EXECUTE FUNCTION yield_cycles_created();

-- ── Row-level security and grants ───────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['yield_cycles', 'yield_cycle_transitions', 'yield_artifact_sets', 'yield_ownership_snapshots',
                           'yield_allocations', 'yield_attestations', 'yield_evidence', 'yield_inputs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_bypass ON %I TO CURRENT_USER USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- Fact tables: read and append. Cycles: UPDATE through the guard. Transitions and set status: trigger only.
GRANT SELECT, INSERT, UPDATE ON yield_cycles TO metafarm_app;
GRANT SELECT ON yield_cycle_transitions TO metafarm_app;
GRANT SELECT, INSERT ON yield_artifact_sets, yield_ownership_snapshots, yield_allocations, yield_attestations, yield_evidence, yield_inputs TO metafarm_app;
GRANT USAGE ON SEQUENCE yield_allocations_id_seq, yield_attestations_id_seq, yield_inputs_id_seq TO metafarm_app;
REVOKE ALL ON FUNCTION yield_cycles_guard(), yield_cycles_created() FROM PUBLIC;
