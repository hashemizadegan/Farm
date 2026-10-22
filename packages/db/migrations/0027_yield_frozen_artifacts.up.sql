-- G2 (simulation cycles): the frozen cycle artifact and its claim leaves, persisted at `calculate`, so reads (Y13
-- proofs, review, reconciliation) never recompute. Content-addressed and immutable:
-- - yield_frozen_artifacts: one per artifact set; `body` is the canonical artifact text (`canonicalYieldArtifact`)
--   and `artifact_sha256` its SHA-256, checked by the database, and equal to the set's `set_hash`;
-- - yield_claim_leaves: every leaf of the set's claim tree with its proof material; the root is the set's root, and
--   each leaf's amount is its party's `allocated` row.
-- Rows are added only while the cycle is being calculated (inputs_locked, set frozen), never changed or deleted.
-- From this migration on, `calculate` (inputs_locked → calculated) also needs the set's frozen artifact: an
-- additional trigger; nothing in 0024 is relaxed. Real cycles never get here (real gate), and are refused here too.

CREATE TABLE yield_frozen_artifacts (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  cycle_id         uuid NOT NULL,
  artifact_set_id  uuid NOT NULL,
  scheme           text NOT NULL CHECK (scheme ~ '^[a-z0-9][a-z0-9._:/\-]{0,127}$'),
  body             text NOT NULL CHECK (length(body) BETWEEN 2 AND 200000000),
  artifact_sha256  text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  leaf_count       integer NOT NULL CHECK (leaf_count >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_set_id),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES yield_cycles(tenant_id, id),
  FOREIGN KEY (artifact_set_id, cycle_id) REFERENCES yield_artifact_sets(id, cycle_id),
  CONSTRAINT yield_frozen_artifacts_content_hash CHECK (artifact_sha256 = encode(sha256(convert_to(body, 'UTF8')), 'hex'))
);
CREATE INDEX yield_frozen_artifacts_cycle_idx ON yield_frozen_artifacts (tenant_id, cycle_id);

CREATE TABLE yield_claim_leaves (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  cycle_id         uuid NOT NULL,
  artifact_set_id  uuid NOT NULL,
  leaf_index       integer NOT NULL CHECK (leaf_index >= 0),
  tree_size        integer NOT NULL CHECK (tree_size >= 1),
  party_id         uuid NOT NULL,
  payout_wallet    text NOT NULL CHECK (length(payout_wallet) BETWEEN 32 AND 64),
  recipient        text NOT NULL CHECK (recipient ~ '^[0-9a-f]{64}$'),
  amount           numeric(78, 0) NOT NULL CHECK (amount > 0 AND amount <= 18446744073709551615),
  -- Hex of the leaf bytes (layout 1: 201 bytes, layout 2: 233 bytes).
  leaf_bytes       text NOT NULL CHECK (leaf_bytes ~ '^[0-9a-f]+$' AND length(leaf_bytes) IN (402, 466)),
  leaf_hash        text NOT NULL CHECK (leaf_hash ~ '^[0-9a-f]{64}$'),
  -- RFC 9162 audit path, nearest sibling first.
  proof_path       text[] NOT NULL CHECK (array_position(proof_path, NULL) IS NULL),
  root             text NOT NULL CHECK (root ~ '^[0-9a-f]{64}$'),
  hasher_id        text NOT NULL CHECK (length(hasher_id) BETWEEN 1 AND 128),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_set_id, leaf_index),
  UNIQUE (artifact_set_id, recipient),
  UNIQUE (artifact_set_id, party_id),
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES yield_cycles(tenant_id, id),
  FOREIGN KEY (artifact_set_id, cycle_id) REFERENCES yield_artifact_sets(id, cycle_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  CHECK (leaf_index < tree_size)
);
CREATE INDEX yield_claim_leaves_set_idx ON yield_claim_leaves (tenant_id, artifact_set_id, leaf_index);

CREATE FUNCTION yield_frozen_artifacts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c yield_cycles%ROWTYPE; s yield_artifact_sets%ROWTYPE;
BEGIN
  SELECT * INTO c FROM yield_cycles WHERE tenant_id = NEW.tenant_id AND id = NEW.cycle_id;
  SELECT * INTO s FROM yield_artifact_sets WHERE id = NEW.artifact_set_id;
  IF c.id IS NULL OR s.id IS NULL THEN
    RETURN NEW; -- the foreign keys refuse it
  END IF;
  IF NOT c.simulation THEN
    RAISE EXCEPTION 'frozen artifacts are persisted for simulation cycles only' USING ERRCODE = 'check_violation', HINT = 'yield:real_gate';
  END IF;
  IF c.status <> 'inputs_locked' OR s.status <> 'frozen' THEN
    RAISE EXCEPTION '% rows are added only while the cycle is calculated (cycle %, set %)', TG_TABLE_NAME, c.status, s.status USING ERRCODE = 'check_violation', HINT = 'yield:not_calculating';
  END IF;
  IF TG_TABLE_NAME = 'yield_frozen_artifacts' THEN
    IF NEW.artifact_sha256 IS DISTINCT FROM s.set_hash THEN
      RAISE EXCEPTION 'the frozen artifact does not hash to its set''s hash' USING ERRCODE = 'check_violation', HINT = 'yield:artifact_mismatch';
    END IF;
  ELSE
    IF NEW.root IS DISTINCT FROM s.merkle_root THEN
      RAISE EXCEPTION 'the leaf''s root is not its set''s root' USING ERRCODE = 'check_violation', HINT = 'yield:artifact_mismatch';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM yield_frozen_artifacts f WHERE f.artifact_set_id = NEW.artifact_set_id AND NEW.tree_size = f.leaf_count) THEN
      RAISE EXCEPTION 'leaves follow their frozen artifact, and the tree size is its leaf count' USING ERRCODE = 'check_violation', HINT = 'yield:artifact_mismatch';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM yield_allocations a WHERE a.artifact_set_id = NEW.artifact_set_id AND a.party_id = NEW.party_id AND a.kind = 'allocated' AND a.amount = NEW.amount) THEN
      RAISE EXCEPTION 'a leaf pays exactly its party''s allocated amount' USING ERRCODE = 'check_violation', HINT = 'yield:artifact_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yield_frozen_artifacts_guard BEFORE INSERT ON yield_frozen_artifacts FOR EACH ROW EXECUTE FUNCTION yield_frozen_artifacts_guard();
CREATE TRIGGER yield_claim_leaves_guard BEFORE INSERT ON yield_claim_leaves FOR EACH ROW EXECUTE FUNCTION yield_frozen_artifacts_guard();
CREATE TRIGGER yield_frozen_artifacts_append_only BEFORE UPDATE OR DELETE ON yield_frozen_artifacts FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER yield_claim_leaves_append_only BEFORE UPDATE OR DELETE ON yield_claim_leaves FOR EACH ROW EXECUTE FUNCTION append_only();

-- `calculate` freezes a persisted artifact: the set the cycle names must have its frozen artifact and exactly
-- leaf_count leaves. Runs after yield_cycles_guard (trigger order is by name).
CREATE FUNCTION yield_cycles_require_frozen_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f yield_frozen_artifacts%ROWTYPE;
BEGIN
  IF OLD.status = 'inputs_locked' AND NEW.status = 'calculated' THEN
    SELECT fa.* INTO f FROM yield_frozen_artifacts fa JOIN yield_artifact_sets s ON s.id = fa.artifact_set_id
     WHERE s.cycle_id = NEW.id AND s.status = 'frozen' AND s.set_hash = NEW.artifact_set_hash;
    IF f.id IS NULL THEN
      RAISE EXCEPTION 'calculate needs the frozen artifact of the set it names' USING ERRCODE = 'check_violation', HINT = 'yield:artifact_missing';
    END IF;
    IF (SELECT count(*) FROM yield_claim_leaves l WHERE l.artifact_set_id = f.artifact_set_id) <> f.leaf_count THEN
      RAISE EXCEPTION 'the frozen artifact has % leaves, not all persisted', f.leaf_count USING ERRCODE = 'check_violation', HINT = 'yield:artifact_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER yield_cycles_require_frozen_artifact BEFORE UPDATE ON yield_cycles FOR EACH ROW EXECUTE FUNCTION yield_cycles_require_frozen_artifact();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['yield_frozen_artifacts', 'yield_claim_leaves'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_bypass ON %I TO CURRENT_USER USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON yield_frozen_artifacts, yield_claim_leaves TO metafarm_app;
GRANT USAGE ON SEQUENCE yield_frozen_artifacts_id_seq, yield_claim_leaves_id_seq TO metafarm_app;
