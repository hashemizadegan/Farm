-- Farm inputs and an append-only stock movement log (doubles as the spray/fertilizer record).

CREATE TABLE input_items (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  category                   text NOT NULL CHECK (category IN ('seed', 'fertilizer', 'crop-protection', 'fuel', 'packaging', 'other')),
  unit                       text NOT NULL CHECK (length(unit) BETWEEN 1 AND 16),
  reorder_level              numeric(14, 3) CHECK (reorder_level >= 0),
  pre_harvest_interval_days  integer CHECK (pre_harvest_interval_days BETWEEN 0 AND 365),
  re_entry_hours             integer CHECK (re_entry_hours BETWEEN 0 AND 720),
  notes                      text CHECK (length(notes) <= 2000),
  archived_at                timestamptz,
  created_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX input_items_name_idx ON input_items(tenant_id, lower(name));

CREATE TABLE stock_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('receive', 'use', 'adjust')),
  -- Signed change to stock: receive > 0, use < 0, adjust either way.
  quantity      numeric(14, 3) NOT NULL CHECK (quantity <> 0),
  occurred_on   date NOT NULL,
  farm_id       uuid,
  parcel_label  text CHECK (length(parcel_label) <= 80),
  task_id       uuid REFERENCES farm_tasks(id) ON DELETE SET NULL,
  supplier      text CHECK (length(supplier) <= 120),
  lot           text CHECK (length(lot) <= 60),
  expires_on    date,
  cost          numeric(15, 2) CHECK (cost >= 0),
  currency      text CHECK (currency ~ '^[A-Z]{3}$'),
  note          text CHECK (length(note) <= 1000),
  recorded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, item_id) REFERENCES input_items(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE,
  CHECK ((kind = 'receive' AND quantity > 0) OR (kind = 'use' AND quantity < 0 AND farm_id IS NOT NULL) OR kind = 'adjust')
);
CREATE INDEX stock_movements_item_idx ON stock_movements(tenant_id, item_id, occurred_on DESC, created_at DESC);
CREATE INDEX stock_movements_farm_idx ON stock_movements(tenant_id, farm_id, occurred_on DESC) WHERE farm_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['input_items', 'stock_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_bypass ON %I TO CURRENT_USER USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON input_items TO metafarm_app;
-- The movement log is append-only for the app.
GRANT SELECT, INSERT ON stock_movements TO metafarm_app;
