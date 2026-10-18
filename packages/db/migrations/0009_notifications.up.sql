-- Per-person notifications. Stored as a kind plus data, so each reader sees them in their own language.

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('task_assigned', 'alert_raised', 'low_stock', 'maintenance_due')),
  data        jsonb NOT NULL DEFAULT '{}',
  -- One notification per person per event, however many times the event is seen.
  dedupe_key  text NOT NULL CHECK (length(dedupe_key) <= 200),
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, dedupe_key)
);
CREATE INDEX notifications_user_idx ON notifications(tenant_id, user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications(tenant_id, user_id) WHERE read_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications TO metafarm_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON notifications TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO metafarm_app;
