-- Registered integrations: external sensor and observation feeds that post signed events to
-- POST /v1/integrations/{id}/events (apps/api routes/integrations.ts). The workspace of every event is the
-- integration's own; a workspace named in a payload is refused. Nothing earlier is altered.
--
-- Secrets: an integration's signing secret is derived on the server from INTEGRATION_SECRET_KEY, the integration id
-- and `secret_version` (HMAC-SHA256); it is shown once at registration and rotation and never stored. The table keeps
-- only its SHA-256 (`secret_sha256`), which identifies the current secret and detects a changed server key.
-- Rotation increments `secret_version` (the previous secret stops working at once); revocation is final.

CREATE TABLE integrations (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  kind                 text NOT NULL CHECK (kind IN ('sensor_feed', 'observation_feed')),
  provider             text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name                 text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  secret_version       integer NOT NULL DEFAULT 1 CHECK (secret_version >= 1),
  secret_sha256        text NOT NULL CHECK (secret_sha256 ~ '^[0-9a-f]{64}$'),
  allowed_event_types  text[] NOT NULL CHECK (cardinality(allowed_event_types) BETWEEN 1 AND 16),
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  rotated_at           timestamptz,
  last_seen_at         timestamptz,
  revoked_at           timestamptz,
  UNIQUE (tenant_id, id),
  CONSTRAINT integrations_revocation CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX integrations_tenant_idx ON integrations (tenant_id, created_at DESC);

-- Revocation is final; the id, workspace, kind, provider and creator never change.
CREATE FUNCTION integrations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.kind <> OLD.kind OR NEW.provider <> OLD.provider OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an integration''s identity does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'revoked' AND (NEW.status <> 'revoked' OR NEW.secret_version <> OLD.secret_version) THEN
    RAISE EXCEPTION 'a revoked integration stays revoked' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.secret_version < OLD.secret_version THEN
    RAISE EXCEPTION 'secret versions only increase' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integrations_guard BEFORE UPDATE ON integrations FOR EACH ROW EXECUTE FUNCTION integrations_guard();

-- One row per accepted provider event: (integration, provider event id) is the idempotency key. Written in the same
-- transaction as the observations it produced, so a replay can never ingest twice.
CREATE TABLE integration_events (
  integration_id     uuid NOT NULL,
  provider_event_id  text NOT NULL CHECK (provider_event_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  tenant_id          uuid NOT NULL,
  event_type         text NOT NULL,
  payload_sha256     text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  raw_observation_ids uuid[] NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, provider_event_id),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES integrations(tenant_id, id) ON DELETE RESTRICT
);
CREATE TRIGGER integration_events_append_only BEFORE UPDATE OR DELETE ON integration_events FOR EACH ROW EXECUTE FUNCTION append_only();

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON integrations TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON integrations TO metafarm_app;

ALTER TABLE integration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_events TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON integration_events TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON integration_events TO metafarm_app;
