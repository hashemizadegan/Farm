ALTER TABLE rwa_orders DROP COLUMN IF EXISTS investor_solana_address, DROP COLUMN IF EXISTS investor_tron_address;
DROP INDEX IF EXISTS settlement_intents_observed_tx_idx;
ALTER TABLE settlement_intents DROP CONSTRAINT IF EXISTS settlement_inbound_observed,
  DROP COLUMN IF EXISTS observed_at, DROP COLUMN IF EXISTS observed_block, DROP COLUMN IF EXISTS observed_amount,
  DROP COLUMN IF EXISTS observed_tx_ref, DROP COLUMN IF EXISTS direction;
