-- Farm archiving, workspace invitations, and user-supplied profile details.

ALTER TABLE farms ADD COLUMN archived_at timestamptz;
CREATE INDEX farms_tenant_active_idx ON farms(tenant_id, created_at DESC) WHERE archived_at IS NULL;

-- Invitations are links an admin shares. Only a SHA-256 of the token is stored;
-- the token itself is shown once, to the person who created the invitation.
CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email        citext NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  role         text NOT NULL REFERENCES roles(name),
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by   uuid REFERENCES users(id),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  uuid REFERENCES users(id),
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_tenant_idx ON invitations(tenant_id, created_at DESC);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitations TO metafarm_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON invitations TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO metafarm_app;

