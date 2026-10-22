-- Line join (2026-10-22): the simulation calculation dossier of a cycle (packages/domain yield/simulation-dossier.ts).
-- Content-addressed (sha256 is the SHA-256 of the exact canonical text), append-only, simulation cycles only, and
-- registered only while the cycle is in draft: what was registered when the inputs were locked is what `calculate`
-- uses (the latest revision). The engine checks the dossier against the locked cycle; this table only stores it.
-- Nothing existing is altered.

CREATE TABLE yield_simulation_dossiers (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  cycle_id     uuid NOT NULL,
  revision     integer NOT NULL CHECK (revision >= 1),
  body         text NOT NULL CHECK (length(body) BETWEEN 2 AND 4000000),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, revision),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES yield_cycles(tenant_id, id),
  CONSTRAINT yield_simulation_dossiers_content_hash CHECK (sha256 = encode(sha256(convert_to(body, 'UTF8')), 'hex'))
);
CREATE INDEX yield_simulation_dossiers_cycle_idx ON yield_simulation_dossiers (tenant_id, cycle_id, revision DESC);

CREATE FUNCTION yield_simulation_dossiers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c yield_cycles%ROWTYPE;
BEGIN
  SELECT * INTO c FROM yield_cycles WHERE tenant_id = NEW.tenant_id AND id = NEW.cycle_id;
  IF c.id IS NULL THEN
    RETURN NEW; -- the foreign key refuses it
  END IF;
  IF NOT c.simulation THEN
    RAISE EXCEPTION 'a simulation dossier belongs to a simulation cycle only' USING ERRCODE = 'check_violation', HINT = 'yield:simulation_record_in_real_cycle';
  END IF;
  IF c.status <> 'draft' THEN
    RAISE EXCEPTION 'a simulation dossier is registered while the cycle is a draft (cycle is %)', c.status USING ERRCODE = 'check_violation', HINT = 'yield:cycle_not_draft';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yield_simulation_dossiers_guard BEFORE INSERT ON yield_simulation_dossiers
  FOR EACH ROW EXECUTE FUNCTION yield_simulation_dossiers_guard();
CREATE TRIGGER yield_simulation_dossiers_append_only BEFORE UPDATE OR DELETE ON yield_simulation_dossiers
  FOR EACH ROW EXECUTE FUNCTION append_only();

ALTER TABLE yield_simulation_dossiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE yield_simulation_dossiers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON yield_simulation_dossiers TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON yield_simulation_dossiers TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON yield_simulation_dossiers TO metafarm_app;
GRANT USAGE ON SEQUENCE yield_simulation_dossiers_id_seq TO metafarm_app;
