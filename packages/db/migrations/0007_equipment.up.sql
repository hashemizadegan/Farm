-- Equipment, hour-meter readings, maintenance plans and the service log.

CREATE TABLE equipment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind          text NOT NULL CHECK (kind IN ('tractor', 'sprayer', 'harvester', 'pump', 'irrigation', 'vehicle', 'implement', 'tool', 'other')),
  make_model    text CHECK (length(make_model) <= 120),
  serial        text CHECK (length(serial) <= 80),
  farm_id       uuid,
  tracks_hours  boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'out_of_service', 'retired')),
  status_note   text CHECK (length(status_note) <= 500),
  notes         text CHECK (length(notes) <= 2000),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE SET NULL (farm_id)
);
CREATE UNIQUE INDEX equipment_name_idx ON equipment(tenant_id, lower(name));

CREATE TABLE meter_readings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  equipment_id  uuid NOT NULL,
  hours         numeric(9, 1) NOT NULL CHECK (hours >= 0),
  read_on       date NOT NULL,
  note          text CHECK (length(note) <= 500),
  recorded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX meter_readings_idx ON meter_readings(tenant_id, equipment_id, read_on DESC, created_at DESC);

CREATE TABLE maintenance_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  equipment_id     uuid NOT NULL,
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  every_hours      integer CHECK (every_hours BETWEEN 1 AND 100000),
  every_days       integer CHECK (every_days BETWEEN 1 AND 3650),
  last_done_on     date NOT NULL,
  last_done_hours  numeric(9, 1),
  notes            text CHECK (length(notes) <= 1000),
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment(tenant_id, id) ON DELETE CASCADE,
  CHECK (every_hours IS NOT NULL OR every_days IS NOT NULL),
  CHECK (every_hours IS NULL OR last_done_hours IS NOT NULL)
);

CREATE TABLE service_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  equipment_id  uuid NOT NULL,
  plan_id       uuid,
  done_on       date NOT NULL,
  hours         numeric(9, 1),
  description   text NOT NULL CHECK (length(description) BETWEEN 1 AND 1000),
  cost          numeric(15, 2) CHECK (cost >= 0),
  currency      text CHECK (currency ~ '^[A-Z]{3}$'),
  recorded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, equipment_id) REFERENCES equipment(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, plan_id) REFERENCES maintenance_plans(tenant_id, id),
  CHECK ((cost IS NULL) = (currency IS NULL))
);
CREATE INDEX service_records_idx ON service_records(tenant_id, equipment_id, done_on DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['equipment', 'meter_readings', 'maintenance_plans', 'service_records'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_bypass ON %I TO CURRENT_USER USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON equipment, maintenance_plans TO metafarm_app;
-- Readings and the service log are history: append-only for the app.
GRANT SELECT, INSERT ON meter_readings, service_records TO metafarm_app;
