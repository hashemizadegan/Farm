-- Live sensors: device credentials, last contact, and alert rules managed in the app.

ALTER TABLE sensors
  ADD COLUMN parcel_label text CHECK (length(parcel_label) <= 80),
  ADD COLUMN last_seen_at timestamptz,
  ADD COLUMN silent_after_minutes integer NOT NULL DEFAULT 180 CHECK (silent_after_minutes BETWEEN 5 AND 10080),
  ADD COLUMN credential_rotated_at timestamptz,
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT sensors_name_len CHECK (length(name) BETWEEN 1 AND 120),
  ADD CONSTRAINT sensors_credential_hash CHECK (credential_hash IS NULL OR credential_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX sensors_credential_idx ON sensors(credential_hash) WHERE credential_hash IS NOT NULL;
CREATE INDEX sensors_farm_idx ON sensors(tenant_id, farm_id);

ALTER TABLE alert_rules ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Alerts that are not about a rule (e.g. a sensor that went silent) carry the sensor instead.
ALTER TABLE alerts ADD COLUMN sensor_id uuid;
CREATE INDEX observations_sensor_idx ON observations(tenant_id, sensor_id, metric, observed_at DESC) WHERE sensor_id IS NOT NULL;

-- Devices are audit actors too (rejected sensor tokens).
ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_type_check CHECK (actor_type IN ('user', 'system', 'webhook', 'job', 'device'));
