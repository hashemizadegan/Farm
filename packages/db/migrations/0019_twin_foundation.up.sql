-- Digital-twin foundation: three more kinds of physical asset in the registry (buildings, storage
-- units, logistics lots), and verifiable off-chain data: content-hash commitments and Merkle batches
-- of them. Ownership is not stored here: it is read from the chain. Additive.

ALTER TABLE business_assets DROP CONSTRAINT business_assets_kind_check;
ALTER TABLE business_assets ADD CONSTRAINT business_assets_kind_check CHECK (kind IN ('parcel', 'tree', 'livestock', 'equipment', 'harvest_lot', 'farm_share', 'building', 'storage_unit', 'logistics_lot'));

-- ── Data commitments ────────────────────────────────────────────────────
-- One row says: data about this subject, under this schema, had exactly this SHA-256 at this source
-- time, and its bytes are kept here. Rows are never changed or deleted (no UPDATE or DELETE grant).

CREATE TABLE data_commitments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  farm_id            uuid,
  subject_type       text NOT NULL CHECK (subject_type IN ('farm', 'asset', 'telemetry_window', 'media', 'record', 'scene_bundle')),
  subject_id         text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
  data_schema        text NOT NULL CHECK (data_schema ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  schema_version     integer NOT NULL CHECK (schema_version BETWEEN 1 AND 10000),
  content_sha256     text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size          bigint CHECK (byte_size >= 0),
  -- Content-addressed only (checked by the API): sha256:<hex>, s3://…/<hex>[.ext], ipfs://, ar://.
  storage_ref        text CHECK (storage_ref IS NULL OR length(storage_ref) BETWEEN 1 AND 512),
  source_time        timestamptz NOT NULL,
  attestation_ref    text CHECK (attestation_ref IS NULL OR length(attestation_ref) BETWEEN 1 AND 512),
  recorded_by        uuid REFERENCES users(id),
  client_request_id  uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, subject_type, subject_id, data_schema, schema_version, content_sha256),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX data_commitments_subject_idx ON data_commitments (tenant_id, subject_type, subject_id, created_at DESC);
CREATE UNIQUE INDEX data_commitments_request_idx ON data_commitments (tenant_id, client_request_id) WHERE client_request_id IS NOT NULL;

-- ── Merkle batches ──────────────────────────────────────────────────────
-- A batch fixes an ordered list of commitments and its RFC 9162 root (metafarm-merkle-sha256/1).
-- A commitment joins at most one batch. Writing roots on-chain comes later; nothing here claims it.

CREATE TABLE commitment_batches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  dataset            text NOT NULL CHECK (dataset ~ '^[a-z0-9][a-z0-9._/-]{0,99}$'),
  scheme             text NOT NULL CHECK (scheme IN ('metafarm-merkle-sha256/1')),
  merkle_root        text NOT NULL CHECK (merkle_root ~ '^[0-9a-f]{64}$'),
  leaf_count         integer NOT NULL CHECK (leaf_count BETWEEN 1 AND 4096),
  created_by         uuid REFERENCES users(id),
  client_request_id  uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX commitment_batches_dataset_idx ON commitment_batches (tenant_id, dataset, created_at DESC);
CREATE UNIQUE INDEX commitment_batches_request_idx ON commitment_batches (tenant_id, client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE commitment_batch_leaves (
  tenant_id      uuid NOT NULL,
  batch_id       uuid NOT NULL,
  leaf_index     integer NOT NULL CHECK (leaf_index BETWEEN 0 AND 4095),
  commitment_id  uuid NOT NULL,
  leaf_hash      text NOT NULL CHECK (leaf_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (batch_id, leaf_index),
  UNIQUE (commitment_id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES commitment_batches(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, commitment_id) REFERENCES data_commitments(tenant_id, id) ON DELETE RESTRICT
);

-- ── Row-level security and grants ──────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['data_commitments', 'commitment_batches', 'commitment_batch_leaves'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_bypass ON %I TO CURRENT_USER USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- Append-only for the application: no UPDATE, no DELETE.
GRANT SELECT, INSERT ON data_commitments, commitment_batches, commitment_batch_leaves TO metafarm_app;
