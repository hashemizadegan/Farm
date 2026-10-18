UPDATE audit_events SET actor_type = 'webhook' WHERE actor_type = 'device';
ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_type_check CHECK (actor_type IN ('user', 'system', 'webhook', 'job'));
DROP INDEX IF EXISTS observations_sensor_idx;
ALTER TABLE alerts DROP COLUMN IF EXISTS sensor_id;
ALTER TABLE alert_rules DROP COLUMN IF EXISTS created_by;
DROP INDEX IF EXISTS sensors_farm_idx;
DROP INDEX IF EXISTS sensors_credential_idx;
ALTER TABLE sensors
  DROP CONSTRAINT IF EXISTS sensors_credential_hash,
  DROP CONSTRAINT IF EXISTS sensors_name_len,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS credential_rotated_at,
  DROP COLUMN IF EXISTS silent_after_minutes,
  DROP COLUMN IF EXISTS last_seen_at,
  DROP COLUMN IF EXISTS parcel_label;
