-- Harvest batches with a public traceability record. The record and its SHA-256
-- never change after insert; mistakes are voided (and the void is registered too).

CREATE TABLE harvest_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id          uuid NOT NULL,
  -- Code printed on labels and used in the public URL.
  code             text NOT NULL UNIQUE CHECK (code ~ '^[2-9A-HJKMNP-Z]{10}$'),
  crop_name        text NOT NULL CHECK (length(crop_name) BETWEEN 1 AND 120),
  parcel_label     text CHECK (length(parcel_label) <= 80),
  harvested_on     date NOT NULL,
  quantity         numeric(14, 3) NOT NULL CHECK (quantity > 0),
  unit             text NOT NULL CHECK (length(unit) BETWEEN 1 AND 16),
  quality_grade    text CHECK (length(quality_grade) <= 40),
  notes            text CHECK (length(notes) <= 4000),
  task_id          uuid REFERENCES farm_tasks(id) ON DELETE SET NULL,
  public_record    jsonb NOT NULL,
  record_hash      text NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  anchor_status    text NOT NULL DEFAULT 'not_configured'
                   CHECK (anchor_status IN ('not_configured', 'pending', 'submitted', 'confirmed', 'failed')),
  anchor_attempt   integer NOT NULL DEFAULT 0,
  anchor_chain_id  integer,
  anchor_contract  text CHECK (anchor_contract ~ '^0x[0-9a-f]{40}$'),
  anchor_tx_hash   text CHECK (anchor_tx_hash ~ '^0x[0-9a-f]{64}$'),
  anchor_block     bigint,
  anchored_at      timestamptz,
  anchor_error     text CHECK (length(anchor_error) <= 500),
  voided_at        timestamptz,
  void_reason      text CHECK (length(void_reason) <= 500),
  void_anchor_status  text CHECK (void_anchor_status IN ('not_configured', 'pending', 'submitted', 'confirmed', 'failed')),
  void_tx_hash     text CHECK (void_tx_hash ~ '^0x[0-9a-f]{64}$'),
  recorded_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX harvest_batches_farm_idx ON harvest_batches(tenant_id, farm_id, harvested_on DESC, created_at DESC);

-- The public record is immutable once written.
CREATE FUNCTION harvest_batches_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.public_record IS DISTINCT FROM OLD.public_record OR NEW.record_hash IS DISTINCT FROM OLD.record_hash
     OR NEW.code IS DISTINCT FROM OLD.code OR NEW.crop_name IS DISTINCT FROM OLD.crop_name
     OR NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.unit IS DISTINCT FROM OLD.unit
     OR NEW.harvested_on IS DISTINCT FROM OLD.harvested_on OR NEW.farm_id IS DISTINCT FROM OLD.farm_id THEN
    RAISE EXCEPTION 'harvest batch records are immutable; void the batch instead';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER harvest_batches_freeze BEFORE UPDATE ON harvest_batches FOR EACH ROW EXECUTE FUNCTION harvest_batches_freeze();

ALTER TABLE harvest_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE harvest_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON harvest_batches TO metafarm_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON harvest_batches TO CURRENT_USER USING (true) WITH CHECK (true);
-- No DELETE for the app: batches are voided, never removed.
GRANT SELECT, INSERT, UPDATE ON harvest_batches TO metafarm_app;
