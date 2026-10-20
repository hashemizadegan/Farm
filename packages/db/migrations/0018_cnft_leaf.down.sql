-- Records are retained: refuse to revert once any leaf metadata or asset-mismatch case exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM asset_representations WHERE cnft_metadata IS NOT NULL OR leaf_hash IS NOT NULL)
     OR EXISTS (SELECT 1 FROM reconciliation_cases WHERE kind = 'asset_mismatch') THEN
    RAISE EXCEPTION '0018 cannot be reverted: compressed NFT metadata or asset-mismatch cases exist and must be retained';
  END IF;
END $$;

ALTER TABLE reconciliation_cases DROP CONSTRAINT reconciliation_cases_kind_check;
ALTER TABLE reconciliation_cases ADD CONSTRAINT reconciliation_cases_kind_check CHECK (kind IN ('amount_mismatch', 'missing_settlement', 'missing_issuance', 'duplicate', 'orphan_chain_tx', 'stale'));

DROP TRIGGER asset_representations_metadata_fixed ON asset_representations;
DROP FUNCTION asset_representations_metadata_fixed();
ALTER TABLE asset_representations DROP CONSTRAINT asset_representations_cnft_has_metadata,
  DROP CONSTRAINT asset_representations_leaf_hash, DROP CONSTRAINT asset_representations_cnft_metadata,
  DROP COLUMN leaf_hash, DROP COLUMN cnft_metadata;
