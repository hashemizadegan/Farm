-- Reverts 0001_init. DESTROYS ALL DATA. Only for local development or a
-- freshly created staging database; production rollback uses backups
-- (see docs/deployment-railway.md).
DROP TABLE IF EXISTS
  webhook_receipts, job_runs, audit_events, wallet_nonces, wallet_links, chain_cursors, chain_events,
  nft_assets, alerts, alert_rules, observations, raw_observations, sensors, plant_instances, asset_catalog,
  crop_scenarios, farm_plans, verification_evidence, boundary_versions, farms, media_objects, consents,
  memberships, roles, users, tenants
CASCADE;
DROP FUNCTION IF EXISTS audit_events_append_only();
DROP FUNCTION IF EXISTS enforce_verified_has_evidence();
DROP FUNCTION IF EXISTS set_updated_at();
DROP FUNCTION IF EXISTS app_current_tenant();
