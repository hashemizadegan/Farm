-- Evidence is retained: refuse to revert once commitments or assets of the new kinds exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM data_commitments) OR EXISTS (SELECT 1 FROM commitment_batches)
     OR EXISTS (SELECT 1 FROM business_assets WHERE kind IN ('building', 'storage_unit', 'logistics_lot')) THEN
    RAISE EXCEPTION '0019 cannot be reverted: data commitments, batches or assets of the new kinds exist and must be retained';
  END IF;
END $$;

DROP TABLE commitment_batch_leaves;
DROP TABLE commitment_batches;
DROP TABLE data_commitments;

ALTER TABLE business_assets DROP CONSTRAINT business_assets_kind_check;
ALTER TABLE business_assets ADD CONSTRAINT business_assets_kind_check CHECK (kind IN ('parcel', 'tree', 'livestock', 'equipment', 'harvest_lot', 'farm_share'));
