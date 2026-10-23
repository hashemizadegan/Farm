-- Realtime retention horizons: per workspace, the highest outbox cursor the retention job has deleted. A subscriber
-- whose replay cursor is below its workspace's horizon may have missed deleted events, so the realtime channel
-- answers `resync` (refresh from the API, then continue from the newest cursor) instead of replaying a silent gap.
-- Written only by the system role (the retention job); the application role reads its own workspace's row.
-- Nothing earlier is altered.

CREATE TABLE realtime_retention_horizons (
  tenant_id           uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  pruned_through_seq  bigint NOT NULL CHECK (pruned_through_seq >= 1),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE realtime_retention_horizons ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_retention_horizons FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON realtime_retention_horizons TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON realtime_retention_horizons TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT ON realtime_retention_horizons TO metafarm_app;
