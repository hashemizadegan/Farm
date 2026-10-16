-- 0001_init: core schema, PostGIS, row-level security.
--
-- Tenant isolation is enforced twice:
--   1. every repository query filters on tenant_id explicitly, and
--   2. row-level security restricts the `metafarm_app` role to rows whose
--      tenant_id matches the transaction-local setting `app.tenant_id`.
-- The API and worker switch to `metafarm_app` (SET LOCAL ROLE) for every
-- tenant-scoped transaction, so RLS applies even if they connect as the
-- database owner.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metafarm_app') THEN
    CREATE ROLE metafarm_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- Allow the connecting user to assume the restricted role.
DO $$
BEGIN
  EXECUTE format('GRANT metafarm_app TO %I', current_user);
EXCEPTION WHEN others THEN
  RAISE NOTICE 'could not grant metafarm_app to %: %', current_user, SQLERRM;
END
$$;

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

-- ── Identity & tenancy ────────────────────────────────────────────────────

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_issuer   text NOT NULL,
  oidc_subject  text NOT NULL,
  email         citext,
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (oidc_issuer, oidc_subject)
);

CREATE TABLE roles (
  name         text PRIMARY KEY,
  description  text NOT NULL
);
INSERT INTO roles (name, description) VALUES
  ('owner',    'Full control of the tenant including billing and deletion'),
  ('admin',    'Manage members, settings, NFTs and all farm data'),
  ('manager',  'Create and edit farms, plans, observations and sensors'),
  ('verifier', 'Review boundary evidence and mark boundaries independently verified'),
  ('viewer',   'Read-only access');

CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL REFERENCES roles(name),
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);

CREATE TABLE consents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('terms', 'privacy', 'nft-disclosure', 'data-processing', 'marketing')),
  version     text NOT NULL,
  granted     boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  ip_hash     text
);
CREATE INDEX consents_lookup_idx ON consents(tenant_id, user_id, kind, recorded_at DESC);

-- ── Media ─────────────────────────────────────────────────────────────────

CREATE TABLE media_objects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id       uuid,
  storage_key   text NOT NULL UNIQUE,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  byte_size     bigint NOT NULL CHECK (byte_size > 0),
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  purpose       text NOT NULL CHECK (purpose IN ('boundary-import', 'observation-photo', 'verification-evidence', 'asset-model')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'rejected', 'deleted')),
  uploaded_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_tenant_idx ON media_objects(tenant_id, created_at DESC);

-- ── Farms & boundaries ────────────────────────────────────────────────────

CREATE TABLE farms (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description                 text,
  timezone                    text NOT NULL DEFAULT 'UTC',
  origin                      geometry(Point, 4326),
  origin_provenance           text NOT NULL DEFAULT 'user-entered',
  current_boundary_version_id uuid,
  created_by                  uuid REFERENCES users(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX farms_tenant_idx ON farms(tenant_id, created_at DESC);

ALTER TABLE media_objects
  ADD CONSTRAINT media_farm_fk FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE SET NULL (farm_id);

CREATE TABLE boundary_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id            uuid NOT NULL,
  version            integer NOT NULL CHECK (version > 0),
  geom               geometry(MultiPolygon, 4326) NOT NULL,
  crs                text NOT NULL DEFAULT 'OGC:CRS84',
  source             text NOT NULL CHECK (source IN ('drawn', 'imported', 'coordinates')),
  provenance_label   text NOT NULL DEFAULT 'user-entered'
                       CHECK (provenance_label IN ('user-entered', 'independently-verified')),
  geometry_hash      text NOT NULL,
  area_m2            double precision NOT NULL CHECK (area_m2 > 0),
  vertex_count       integer NOT NULL CHECK (vertex_count > 0),
  validation_status  text NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'valid', 'invalid')),
  validation_issues  jsonb NOT NULL DEFAULT '[]'::jsonb,
  note               text,
  submitted_by       uuid REFERENCES users(id),
  submitted_at       timestamptz NOT NULL DEFAULT now(),
  validated_at       timestamptz,
  UNIQUE (farm_id, version),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX boundary_geom_gix ON boundary_versions USING gist (geom);
CREATE UNIQUE INDEX boundary_tenant_hash_uq ON boundary_versions(tenant_id, geometry_hash)
  WHERE validation_status <> 'invalid';

ALTER TABLE farms
  ADD CONSTRAINT farms_current_boundary_fk FOREIGN KEY (tenant_id, current_boundary_version_id)
  REFERENCES boundary_versions(tenant_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE verification_evidence (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  boundary_version_id  uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('survey-document', 'registry-extract', 'field-inspection', 'other')),
  media_object_id      uuid NOT NULL REFERENCES media_objects(id),
  reviewer_user_id     uuid NOT NULL REFERENCES users(id),
  reviewed_at          timestamptz NOT NULL DEFAULT now(),
  note                 text,
  FOREIGN KEY (tenant_id, boundary_version_id) REFERENCES boundary_versions(tenant_id, id) ON DELETE CASCADE
);

-- A boundary may only be labelled independently-verified when evidence exists.
CREATE OR REPLACE FUNCTION enforce_verified_has_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provenance_label = 'independently-verified' AND NOT EXISTS (
    SELECT 1 FROM verification_evidence e WHERE e.boundary_version_id = NEW.id AND e.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'boundary % cannot be independently-verified without evidence', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER boundary_verified_requires_evidence
  AFTER INSERT OR UPDATE OF provenance_label ON boundary_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_verified_has_evidence();

-- ── Planning ──────────────────────────────────────────────────────────────

CREATE TABLE farm_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id     uuid NOT NULL,
  name        text NOT NULL,
  season      text,
  parcels     jsonb NOT NULL DEFAULT '[]'::jsonb,
  provenance_label text NOT NULL DEFAULT 'user-entered' CHECK (provenance_label = 'user-entered'),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE crop_scenarios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id     uuid NOT NULL,
  kind        text NOT NULL DEFAULT 'simulated' CHECK (kind = 'simulated'),
  input       jsonb NOT NULL,
  result      jsonb NOT NULL,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE
);

-- Global entries have tenant_id NULL and are readable by every tenant.
CREATE TABLE asset_catalog (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid REFERENCES tenants(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('plant', 'equipment', 'structure', 'decoration')),
  name             text NOT NULL,
  description      text,
  model_media_id   uuid REFERENCES media_objects(id),
  procedural       jsonb,
  license          text NOT NULL,
  provenance_label text NOT NULL DEFAULT 'illustrative' CHECK (provenance_label = 'illustrative'),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plant_instances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id          uuid NOT NULL,
  plan_id          uuid,
  entity_key       text NOT NULL,
  asset_catalog_id uuid REFERENCES asset_catalog(id),
  parcel_label     text,
  local_x          double precision NOT NULL,
  local_z          double precision NOT NULL,
  rotation_rad     double precision NOT NULL DEFAULT 0,
  scale            double precision NOT NULL DEFAULT 1 CHECK (scale > 0),
  provenance_label text NOT NULL DEFAULT 'illustrative' CHECK (provenance_label IN ('illustrative', 'user-entered')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, entity_key),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, plan_id) REFERENCES farm_plans(tenant_id, id) ON DELETE CASCADE
);

-- ── Sensors, observations, alerts ─────────────────────────────────────────

CREATE TABLE sensors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id          uuid NOT NULL,
  name             text NOT NULL,
  kind             text NOT NULL,
  location         geometry(Point, 4326),
  -- Only a hash of the device credential is stored; the secret is shown once at creation.
  credential_hash  text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE raw_observations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id      uuid NOT NULL,
  sensor_id    uuid,
  payload      jsonb NOT NULL,
  provenance_label text NOT NULL CHECK (provenance_label IN ('user-entered', 'provider-observation', 'sensor-reported')),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'normalized', 'rejected')),
  error        text,
  received_by  uuid REFERENCES users(id),
  received_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE observations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id          uuid NOT NULL,
  sensor_id        uuid,
  raw_id           uuid UNIQUE REFERENCES raw_observations(id) ON DELETE SET NULL,
  metric           text NOT NULL,
  value            double precision,
  text_value       text,
  unit             text NOT NULL,
  original_value   jsonb NOT NULL,
  original_unit    text NOT NULL,
  observed_at      timestamptz NOT NULL,
  provenance_label text NOT NULL CHECK (provenance_label IN ('user-entered', 'provider-observation', 'sensor-reported')),
  quality_flags    text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX observations_lookup_idx ON observations(tenant_id, farm_id, metric, observed_at DESC);

CREATE TABLE alert_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id         uuid NOT NULL,
  metric          text NOT NULL,
  comparator      text NOT NULL CHECK (comparator IN ('lt', 'lte', 'gt', 'gte')),
  threshold       double precision NOT NULL,
  consecutive     integer NOT NULL DEFAULT 1 CHECK (consecutive BETWEEN 1 AND 50),
  severity        text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  window_seconds  integer NOT NULL DEFAULT 3600 CHECK (window_seconds BETWEEN 60 AND 2592000),
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id       uuid NOT NULL,
  rule_id       uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  severity      text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  message       text NOT NULL,
  dedupe_key    text NOT NULL,
  evidence_observation_ids uuid[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  ack_note      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX alerts_open_idx ON alerts(tenant_id, farm_id, status, created_at DESC);

-- ── Chain & NFTs ──────────────────────────────────────────────────────────

CREATE TABLE nft_assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id           uuid,
  standard          text NOT NULL CHECK (standard IN ('erc721', 'erc1155')),
  chain_id          integer NOT NULL,
  contract_address  text NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  token_id          numeric(78, 0),
  metadata          jsonb NOT NULL,
  metadata_uri      text,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'mint-requested', 'minted', 'failed')),
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, contract_address, token_id)
);

-- Chain events are public data and not tenant-scoped.
CREATE TABLE chain_events (
  id                bigserial PRIMARY KEY,
  chain_id          integer NOT NULL,
  contract_address  text NOT NULL,
  block_number      bigint NOT NULL,
  block_hash        text NOT NULL,
  tx_hash           text NOT NULL,
  log_index         integer NOT NULL,
  event_name        text NOT NULL,
  args              jsonb NOT NULL,
  confirmed         boolean NOT NULL DEFAULT false,
  removed           boolean NOT NULL DEFAULT false,
  indexed_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash, log_index)
);
CREATE INDEX chain_events_block_idx ON chain_events(chain_id, contract_address, block_number);

CREATE TABLE chain_cursors (
  chain_id           integer NOT NULL,
  contract_address   text NOT NULL,
  last_block_number  bigint NOT NULL,
  last_block_hash    text NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract_address)
);

CREATE TABLE wallet_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address     text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  chain_id    integer NOT NULL,
  linked_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (address, chain_id)
);

CREATE TABLE wallet_nonces (
  nonce       text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_nonces_user_idx ON wallet_nonces(user_id);

-- ── Operations ────────────────────────────────────────────────────────────

CREATE TABLE audit_events (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid REFERENCES tenants(id) ON DELETE SET NULL,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type     text NOT NULL CHECK (actor_type IN ('user', 'system', 'webhook', 'job')),
  action         text NOT NULL,
  target_type    text,
  target_id      text,
  outcome        text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'denied', 'failure')),
  request_id     text,
  ip_hash        text,
  user_agent     text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_idx ON audit_events(tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Allow the FK's ON DELETE SET NULL to anonymise rows when a tenant or user is erased.
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id AND NEW.action = OLD.action AND NEW.created_at = OLD.created_at
     AND NEW.metadata = OLD.metadata AND NEW.outcome = OLD.outcome
     AND (NEW.tenant_id IS NULL OR NEW.tenant_id = OLD.tenant_id)
     AND (NEW.actor_user_id IS NULL OR NEW.actor_user_id = OLD.actor_user_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

CREATE TABLE job_runs (
  idempotency_key  text PRIMARY KEY,
  queue            text NOT NULL,
  status           text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'dead-lettered')),
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  result           jsonb,
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);

CREATE TABLE webhook_receipts (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- ── updated_at triggers ───────────────────────────────────────────────────

CREATE TRIGGER tenants_updated BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER farms_updated BEFORE UPDATE ON farms FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER farm_plans_updated BEFORE UPDATE ON farm_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER media_updated BEFORE UPDATE ON media_objects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER nft_assets_updated BEFORE UPDATE ON nft_assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Row-level security ────────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships', 'consents', 'media_objects', 'farms', 'boundary_versions', 'verification_evidence',
    'farm_plans', 'crop_scenarios', 'plant_instances', 'sensors', 'raw_observations', 'observations',
    'alert_rules', 'alerts', 'nft_assets'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t
    );
    EXECUTE format('CREATE POLICY owner_bypass ON %I TO CURRENT_USER USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO metafarm_app', t);
  END LOOP;
END
$$;

-- Catalog: global rows (tenant_id IS NULL) are readable by all tenants; writes only for own tenant.
ALTER TABLE asset_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_read ON asset_catalog FOR SELECT TO metafarm_app
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant());
CREATE POLICY catalog_write ON asset_catalog FOR ALL TO metafarm_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON asset_catalog TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON asset_catalog TO metafarm_app;

-- Audit: the app role may insert and read its own tenant's events, never modify.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_events FOR SELECT TO metafarm_app USING (tenant_id = app_current_tenant());
CREATE POLICY audit_insert ON audit_events FOR INSERT TO metafarm_app WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON audit_events TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON audit_events TO metafarm_app;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO metafarm_app;

-- Non-tenant reference data the app role may read.
GRANT SELECT ON tenants, users, roles TO metafarm_app;
