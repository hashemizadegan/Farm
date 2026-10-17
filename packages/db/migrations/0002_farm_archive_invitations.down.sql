DROP TABLE IF EXISTS invitations;
DROP INDEX IF EXISTS farms_tenant_active_idx;
ALTER TABLE farms DROP COLUMN IF EXISTS archived_at;
