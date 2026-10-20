-- What a compressed NFT leaf commits to, fixed at registration so every attempt to mint it produces
-- the same leaf; the leaf hash recorded when a mint is prepared; and a reconciliation kind for an
-- indexed asset that is not the leaf the platform minted. Additive.

ALTER TABLE asset_representations
  -- name, symbol and uri are what the leaf hashes; commitment and its salt back the public document.
  ADD COLUMN cnft_metadata jsonb,
  ADD COLUMN leaf_hash text,
  ADD CONSTRAINT asset_representations_cnft_metadata CHECK (
    cnft_metadata IS NULL OR (
      rail = 'SOLANA_BUBBLEGUM_CNFT'
      AND jsonb_typeof(cnft_metadata) = 'object'
      AND cnft_metadata ?& ARRAY['name', 'symbol', 'uri', 'commitment']
      AND octet_length(cnft_metadata->>'name') BETWEEN 1 AND 32
      AND octet_length(cnft_metadata->>'symbol') BETWEEN 1 AND 10
      AND octet_length(cnft_metadata->>'uri') BETWEEN 1 AND 200)),
  ADD CONSTRAINT asset_representations_leaf_hash CHECK (leaf_hash IS NULL OR (rail = 'SOLANA_BUBBLEGUM_CNFT' AND leaf_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')),
  -- A compressed NFT is planned with its metadata; it cannot be minted without it.
  ADD CONSTRAINT asset_representations_cnft_has_metadata CHECK (rail <> 'SOLANA_BUBBLEGUM_CNFT' OR status = 'planned' OR cnft_metadata IS NOT NULL);

-- The metadata a leaf hashes never changes once set; a planned leaf is released only by clearing its
-- tree position together (handled by the engine), never its metadata.
CREATE FUNCTION asset_representations_metadata_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.cnft_metadata IS NOT NULL AND NEW.cnft_metadata IS DISTINCT FROM OLD.cnft_metadata THEN
    RAISE EXCEPTION 'a compressed NFT''s metadata is fixed once set' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER asset_representations_metadata_fixed BEFORE UPDATE ON asset_representations
  FOR EACH ROW EXECUTE FUNCTION asset_representations_metadata_fixed();

ALTER TABLE reconciliation_cases DROP CONSTRAINT reconciliation_cases_kind_check;
ALTER TABLE reconciliation_cases ADD CONSTRAINT reconciliation_cases_kind_check CHECK (kind IN ('amount_mismatch', 'missing_settlement', 'missing_issuance', 'duplicate', 'orphan_chain_tx', 'stale', 'asset_mismatch'));
