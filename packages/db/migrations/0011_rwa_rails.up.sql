-- Real-world asset (RWA) rails: a canonical asset registry anchored in surveyed geometry, its
-- on-chain representations (Solana Token-2022, Solana Bubblegum cNFTs, TRON TRC-20), independent
-- issuance and settlement intents, the chain operations that carry them out, reconciliation
-- between the rails, and IoT telemetry. Additive: no existing table changes.
-- Financial records block deleting their workspace (ON DELETE RESTRICT): they must be retained.

-- ── Canonical assets ────────────────────────────────────────────────────

CREATE TABLE business_assets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  farm_id              uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('parcel', 'tree', 'livestock', 'equipment', 'harvest_lot', 'farm_share')),
  name                 text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- Spatial anchor: the verified farm boundary it lies in, and its own surveyed point or area.
  boundary_version_id  uuid,
  geom                 geometry(Geometry, 4326) CHECK (geom IS NULL OR ST_IsValid(geom)),
  geom_provenance      text CHECK (geom_provenance IN ('surveyed', 'gnss', 'user-entered')),
  parcel_label         text,
  -- Tag, serial or registry number in the physical world.
  external_ref         text,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'verified', 'active', 'suspended', 'retired')),
  attributes           jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_by          uuid REFERENCES users(id),
  verified_at          timestamptz,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, boundary_version_id) REFERENCES boundary_versions(tenant_id, id),
  -- Spatial kinds need geometry once verified.
  CHECK (status IN ('draft') OR kind NOT IN ('parcel', 'tree') OR geom IS NOT NULL),
  CHECK ((status IN ('draft')) = (verified_at IS NULL) OR status IN ('suspended', 'retired'))
);
CREATE INDEX business_assets_farm_idx ON business_assets (tenant_id, farm_id, kind);
CREATE INDEX business_assets_geom_idx ON business_assets USING gist (geom);
CREATE UNIQUE INDEX business_assets_ref_idx ON business_assets (tenant_id, kind, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE asset_representations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  asset_id          uuid NOT NULL,
  rail              text NOT NULL CHECK (rail IN ('SOLANA_TOKEN_2022', 'SOLANA_BUBBLEGUM_CNFT', 'TRON_TRC20')),
  network           text NOT NULL CHECK (network IN ('solana-devnet', 'solana-mainnet', 'tron-nile', 'tron-shasta', 'tron-mainnet')),
  status            text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'issuing', 'active', 'frozen', 'retired')),
  -- Token-2022: the mint and its fixed parameters.
  mint_address      text,
  decimals          smallint CHECK (decimals BETWEEN 0 AND 9),
  max_supply        numeric(78, 0) CHECK (max_supply >= 0),
  -- Bubblegum: the tree and leaf; the DAS asset id once indexed.
  merkle_tree       text,
  leaf_index        bigint CHECK (leaf_index >= 0),
  das_asset_id      text,
  -- TRC-20: the contract.
  contract_address  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, asset_id, rail, network),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES business_assets(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((rail LIKE 'SOLANA_%' AND network LIKE 'solana-%') OR (rail = 'TRON_TRC20' AND network LIKE 'tron-%'))
);
CREATE UNIQUE INDEX asset_representations_mint_idx ON asset_representations (network, mint_address) WHERE mint_address IS NOT NULL;
CREATE UNIQUE INDEX asset_representations_leaf_idx ON asset_representations (network, merkle_tree, leaf_index) WHERE merkle_tree IS NOT NULL AND leaf_index IS NOT NULL;
CREATE UNIQUE INDEX asset_representations_das_idx ON asset_representations (network, das_asset_id) WHERE das_asset_id IS NOT NULL;

-- ── Intents (business requests, independent per rail) ───────────────────

CREATE TABLE issuance_intents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  representation_id  uuid NOT NULL,
  action             text NOT NULL CHECK (action IN ('mint', 'burn', 'freeze', 'thaw')),
  amount             numeric(78, 0) CHECK (amount > 0),
  -- Wallet the action concerns (recipient of a mint, holder for burn/freeze/thaw).
  holder_address     text NOT NULL,
  -- Links this intent to its settlement counterpart; there is no cross-chain atomicity.
  reconciliation_id  uuid NOT NULL,
  idempotency_key    uuid NOT NULL,
  status             text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'policy_rejected', 'approved', 'in_progress', 'completed', 'failed', 'cancelled')),
  policy_decision    jsonb,
  requested_by       uuid REFERENCES users(id),
  approved_by        uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, representation_id) REFERENCES asset_representations(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((action IN ('mint', 'burn')) = (amount IS NOT NULL)),
  -- Nobody approves their own request.
  CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM requested_by)
);
CREATE INDEX issuance_intents_recon_idx ON issuance_intents (tenant_id, reconciliation_id);
CREATE INDEX issuance_intents_status_idx ON issuance_intents (tenant_id, status, created_at);

CREATE TABLE settlement_intents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  network              text NOT NULL CHECK (network IN ('tron-nile', 'tron-shasta', 'tron-mainnet')),
  token_contract       text NOT NULL,
  purpose              text NOT NULL CHECK (purpose IN ('subscription', 'distribution', 'redemption', 'fee', 'refund')),
  payer_address        text NOT NULL,
  payee_address        text NOT NULL CHECK (payee_address <> payer_address),
  amount               numeric(78, 0) NOT NULL CHECK (amount > 0),
  reconciliation_id    uuid NOT NULL,
  idempotency_key      uuid NOT NULL,
  status               text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'policy_rejected', 'approved', 'in_progress', 'completed', 'failed', 'cancelled')),
  policy_decision      jsonb,
  requested_by         uuid REFERENCES users(id),
  approved_by          uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM requested_by)
);
CREATE INDEX settlement_intents_recon_idx ON settlement_intents (tenant_id, reconciliation_id);
CREATE INDEX settlement_intents_status_idx ON settlement_intents (tenant_id, status, created_at);

-- ── Chain operations (attempts to land one transaction for an intent) ──

CREATE TABLE chain_operations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  intent_type            text NOT NULL CHECK (intent_type IN ('issuance', 'settlement')),
  intent_id              uuid NOT NULL,
  attempt                integer NOT NULL CHECK (attempt >= 1),
  network                text NOT NULL CHECK (network IN ('solana-devnet', 'solana-mainnet', 'tron-nile', 'tron-shasta', 'tron-mainnet')),
  state                  text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'policy_approved', 'prepared', 'submitted', 'observed', 'confirmed', 'business_completed', 'policy_rejected', 'expired', 'failed')),
  -- Solana signature or TRON transaction id, known once prepared.
  tx_ref                 text,
  -- Validity window: Solana last valid block height, TRON expiration.
  last_valid_block_height bigint,
  expires_at             timestamptz,
  -- Fees: Solana compute-unit price; TRON fee_limit (sun) and estimated energy/bandwidth.
  priority_fee_micro_lamports bigint CHECK (priority_fee_micro_lamports >= 0),
  fee_limit_sun          bigint CHECK (fee_limit_sun >= 0),
  estimated_energy       bigint CHECK (estimated_energy >= 0),
  estimated_bandwidth    bigint CHECK (estimated_bandwidth >= 0),
  -- What was observed on chain.
  observed_slot_or_block bigint,
  confirmations          integer CHECK (confirmations >= 0),
  fee_paid               numeric(78, 0),
  error                  text,
  -- Unsigned transaction summary for audit; never keys or signatures from a signer.
  prepared_summary       jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (intent_type, intent_id, attempt),
  CHECK (state IN ('requested', 'policy_approved', 'policy_rejected') OR tx_ref IS NOT NULL OR state IN ('failed', 'expired'))
);
CREATE UNIQUE INDEX chain_operations_tx_idx ON chain_operations (network, tx_ref) WHERE tx_ref IS NOT NULL;
CREATE INDEX chain_operations_open_idx ON chain_operations (state, updated_at) WHERE state IN ('prepared', 'submitted', 'observed', 'confirmed');
-- At most one live attempt per intent: a new attempt needs the previous one finished.
CREATE UNIQUE INDEX chain_operations_live_idx ON chain_operations (intent_type, intent_id)
  WHERE state NOT IN ('business_completed', 'policy_rejected', 'expired', 'failed');

-- Allowed state changes (packages/domain/src/rwa/lifecycle.ts; a test keeps them in sync).
CREATE FUNCTION chain_operation_transition_allowed(from_state text, to_state text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (from_state, to_state) IN (VALUES
      ('requested', 'policy_approved'),
      ('requested', 'policy_rejected'),
      ('policy_approved', 'prepared'),
      ('policy_approved', 'failed'),
      ('prepared', 'submitted'),
      ('prepared', 'expired'),
      ('prepared', 'failed'),
      ('submitted', 'observed'),
      ('submitted', 'expired'),
      ('submitted', 'failed'),
      ('observed', 'confirmed'),
      ('observed', 'expired'),
      ('observed', 'failed'),
      ('confirmed', 'business_completed')
  )
$$;

CREATE FUNCTION chain_operations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chain operations are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.intent_type IS DISTINCT FROM OLD.intent_type OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
     OR NEW.attempt IS DISTINCT FROM OLD.attempt OR NEW.network IS DISTINCT FROM OLD.network
     OR (OLD.tx_ref IS NOT NULL AND NEW.tx_ref IS DISTINCT FROM OLD.tx_ref) THEN
    RAISE EXCEPTION 'chain operation identity is fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT chain_operation_transition_allowed(OLD.state, NEW.state) THEN
      RAISE EXCEPTION 'chain operation cannot go from % to %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO chain_operation_transitions (tenant_id, operation_id, from_state, to_state)
      VALUES (NEW.tenant_id, NEW.id, OLD.state, NEW.state);
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TABLE chain_operation_transitions (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  operation_id  uuid NOT NULL REFERENCES chain_operations(id),
  from_state    text NOT NULL,
  to_state      text NOT NULL,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chain_operation_transitions_op_idx ON chain_operation_transitions (operation_id, id);

CREATE TRIGGER chain_operations_guard BEFORE UPDATE OR DELETE ON chain_operations FOR EACH ROW EXECUTE FUNCTION chain_operations_guard();

CREATE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER chain_operation_transitions_append_only BEFORE UPDATE OR DELETE ON chain_operation_transitions
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- ── Reconciliation between the rails ───────────────────────────────────

CREATE TABLE reconciliation_cases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  reconciliation_id     uuid NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('amount_mismatch', 'missing_settlement', 'missing_issuance', 'duplicate', 'orphan_chain_tx', 'stale')),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'written_off')),
  issuance_intent_id    uuid,
  settlement_intent_id  uuid,
  expected              jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed              jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution_note       text,
  resolved_by           uuid REFERENCES users(id),
  opened_at             timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, issuance_intent_id) REFERENCES issuance_intents(tenant_id, id),
  FOREIGN KEY (tenant_id, settlement_intent_id) REFERENCES settlement_intents(tenant_id, id),
  CHECK ((status IN ('resolved', 'written_off')) = (resolved_at IS NOT NULL)),
  CHECK (status NOT IN ('resolved', 'written_off') OR (resolution_note IS NOT NULL AND resolved_by IS NOT NULL))
);
-- One open case per discrepancy.
CREATE UNIQUE INDEX reconciliation_cases_open_idx ON reconciliation_cases (tenant_id, reconciliation_id, kind) WHERE status IN ('open', 'investigating');

-- ── IoT telemetry (TimescaleDB hypertable where available) ─────────────

CREATE TABLE iot_telemetry (
  time            timestamptz NOT NULL,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id         uuid NOT NULL,
  sensor_id       uuid NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  asset_id        uuid,
  metric          text NOT NULL,
  value           double precision NOT NULL,
  unit            text NOT NULL,
  quality_flags   text[] NOT NULL DEFAULT '{}',
  -- Integrity: the broker message id and a SHA-256 of the raw payload.
  message_id      text,
  payload_sha256  text CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE,
  -- Natural key: a sensor reports one value per metric per instant; duplicates are dropped.
  PRIMARY KEY (tenant_id, sensor_id, metric, time)
);
CREATE INDEX iot_telemetry_farm_idx ON iot_telemetry (tenant_id, farm_id, metric, time DESC);
CREATE INDEX iot_telemetry_asset_idx ON iot_telemetry (tenant_id, asset_id, time DESC) WHERE asset_id IS NOT NULL;

DO $$
BEGIN
  -- Production images that preload TimescaleDB get a hypertable; plain PostGIS (CI, local) keeps a table.
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb')
     AND coalesce(current_setting('shared_preload_libraries', true), '') LIKE '%timescaledb%' THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
    PERFORM create_hypertable('iot_telemetry', 'time', chunk_time_interval => INTERVAL '1 day', if_not_exists => true);
  END IF;
END $$;

-- ── Row-level security and grants ──────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_assets', 'asset_representations', 'issuance_intents', 'settlement_intents',
                           'chain_operations', 'chain_operation_transitions', 'reconciliation_cases', 'iot_telemetry'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_bypass ON %I TO CURRENT_USER USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON business_assets, asset_representations, issuance_intents, settlement_intents, chain_operations, reconciliation_cases TO metafarm_app;
GRANT SELECT, INSERT ON chain_operation_transitions, iot_telemetry TO metafarm_app;
GRANT USAGE ON SEQUENCE chain_operation_transitions_id_seq TO metafarm_app;
