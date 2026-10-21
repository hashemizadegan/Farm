-- Idempotency for tenant-scoped writes (API hardening). A client sends an Idempotency-Key (UUID) with
-- a write; the first request reserves the key, and its response is stored when it succeeds. A resend
-- with the same key and the same request gets the stored response; a different request under the same
-- key is refused. Keys are scoped to the tenant and the signed-in user.

CREATE TABLE idempotency_records (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           uuid NOT NULL,
  method        text NOT NULL CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
  route         text NOT NULL CHECK (length(route) BETWEEN 1 AND 2048),
  request_hash  text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state         text NOT NULL CHECK (state IN ('pending', 'completed')),
  status_code   integer CHECK (status_code BETWEEN 200 AND 299),
  content_type  text,
  response_body text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  PRIMARY KEY (tenant_id, user_id, key),
  CHECK ((state = 'pending') = (status_code IS NULL AND completed_at IS NULL))
);

CREATE INDEX idempotency_records_expiry ON idempotency_records (tenant_id, user_id, created_at);

ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_records TO metafarm_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON idempotency_records TO CURRENT_USER USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_records TO metafarm_app;
