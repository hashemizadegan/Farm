-- Crop seasons with a growth-stage log; harvests can belong to a season.

CREATE TABLE crop_seasons (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id                uuid NOT NULL,
  crop_name              text NOT NULL CHECK (length(crop_name) BETWEEN 1 AND 120),
  variety                text CHECK (length(variety) <= 120),
  -- NULL means the whole farm.
  parcel_label           text CHECK (length(parcel_label) <= 80),
  area_ha                numeric(11, 4) CHECK (area_ha > 0),
  planned_start          date NOT NULL,
  expected_harvest_from  date,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('planned', 'active', 'closed')),
  ended_on               date,
  notes                  text CHECK (length(notes) <= 4000),
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  CHECK ((status = 'closed') = (ended_on IS NOT NULL)),
  CHECK (ended_on IS NULL OR ended_on >= planned_start)
);
CREATE INDEX crop_seasons_farm_idx ON crop_seasons(tenant_id, farm_id, status, planned_start DESC);

CREATE TABLE season_stages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  season_id    uuid NOT NULL,
  stage        text NOT NULL CHECK (stage IN ('land-preparation', 'sowing', 'emergence', 'vegetative', 'flowering', 'fruit-set', 'ripening', 'harvest', 'post-harvest')),
  observed_on  date NOT NULL,
  note         text CHECK (length(note) <= 2000),
  recorded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, season_id) REFERENCES crop_seasons(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX season_stages_season_idx ON season_stages(tenant_id, season_id, observed_on);

ALTER TABLE harvest_batches ADD COLUMN season_id uuid;
ALTER TABLE harvest_batches ADD FOREIGN KEY (tenant_id, season_id) REFERENCES crop_seasons(tenant_id, id);
CREATE INDEX harvest_batches_season_idx ON harvest_batches(tenant_id, season_id) WHERE season_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crop_seasons', 'season_stages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_bypass ON %I TO CURRENT_USER USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON crop_seasons TO metafarm_app;
GRANT SELECT, INSERT ON season_stages TO metafarm_app;
