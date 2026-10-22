-- Y13 (simulation only): unsigned claim-intent batches, built from the persisted leaves of migration 0027 and never
-- recomputed (packages/domain yield/claim-intent.ts). An intent is data: nothing here is signed or submitted.
-- One batch per approved artifact set of a published simulation cycle, content-addressed (the database checks the
-- body's SHA-256 and that the body names the set's hash and number), append-only. Nothing earlier is altered.

CREATE TABLE yield_claim_intent_batches (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  cycle_id         uuid NOT NULL,
  artifact_set_id  uuid NOT NULL,
  set_number       integer NOT NULL CHECK (set_number >= 1),
  batch_sha256     text NOT NULL CHECK (batch_sha256 ~ '^[0-9a-f]{64}$'),
  body             text NOT NULL CHECK (length(body) BETWEEN 2 AND 200000000),
  intent_count     integer NOT NULL CHECK (intent_count >= 1),
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_set_id),
  UNIQUE (cycle_id, set_number, batch_sha256),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES yield_cycles(tenant_id, id),
  FOREIGN KEY (artifact_set_id, cycle_id) REFERENCES yield_artifact_sets(id, cycle_id),
  CONSTRAINT yield_claim_intent_batches_content_hash CHECK (batch_sha256 = encode(sha256(convert_to(body, 'UTF8')), 'hex'))
);
CREATE INDEX yield_claim_intent_batches_cycle_idx ON yield_claim_intent_batches (tenant_id, cycle_id);

CREATE FUNCTION yield_claim_intent_batches_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c yield_cycles%ROWTYPE; s yield_artifact_sets%ROWTYPE; b jsonb; leaves integer;
BEGIN
  SELECT * INTO c FROM yield_cycles WHERE tenant_id = NEW.tenant_id AND id = NEW.cycle_id;
  SELECT * INTO s FROM yield_artifact_sets WHERE id = NEW.artifact_set_id;
  IF c.id IS NULL OR s.id IS NULL THEN
    RETURN NEW; -- the foreign keys refuse it
  END IF;
  IF NOT c.simulation THEN
    RAISE EXCEPTION 'claim intents are built for simulation cycles only' USING ERRCODE = 'check_violation', HINT = 'yield:real_gate';
  END IF;
  IF c.status <> 'published' OR s.status <> 'approved' OR s.set_hash IS DISTINCT FROM c.artifact_set_hash THEN
    RAISE EXCEPTION 'claim intents need a published cycle and its approved set (cycle %, set %)', c.status, s.status USING ERRCODE = 'check_violation', HINT = 'yield:invalid_state';
  END IF;
  b := NEW.body::jsonb;
  IF b->>'scheme' IS DISTINCT FROM 'metafarm-yield-claim-intent-batch/1' OR b->>'artifactSetHash' IS DISTINCT FROM s.set_hash
     OR (b->>'setNumber')::integer IS DISTINCT FROM s.set_number OR NEW.set_number <> s.set_number OR b->>'cycleId' IS DISTINCT FROM c.id::text
     OR b->>'signed' IS DISTINCT FROM 'false' OR b->>'simulation' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'the batch does not name its cycle and set, or is not an unsigned simulation batch' USING ERRCODE = 'check_violation', HINT = 'yield:artifact_mismatch';
  END IF;
  SELECT count(*) INTO leaves FROM yield_claim_leaves WHERE artifact_set_id = NEW.artifact_set_id;
  IF NEW.intent_count <> leaves OR jsonb_array_length(b->'intents') <> leaves THEN
    RAISE EXCEPTION 'the batch has % intents for % stored leaves', NEW.intent_count, leaves USING ERRCODE = 'check_violation', HINT = 'yield:artifact_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yield_claim_intent_batches_guard BEFORE INSERT ON yield_claim_intent_batches FOR EACH ROW EXECUTE FUNCTION yield_claim_intent_batches_guard();
CREATE TRIGGER yield_claim_intent_batches_append_only BEFORE UPDATE OR DELETE ON yield_claim_intent_batches FOR EACH ROW EXECUTE FUNCTION append_only();

ALTER TABLE yield_claim_intent_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE yield_claim_intent_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON yield_claim_intent_batches TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON yield_claim_intent_batches TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON yield_claim_intent_batches TO metafarm_app;
GRANT USAGE ON SEQUENCE yield_claim_intent_batches_id_seq TO metafarm_app;
