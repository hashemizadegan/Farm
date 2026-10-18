-- Payments received rather than sent (an investor's subscription): the settlement intent records
-- the verified on-chain transfer. A payment can be counted for one order only.
ALTER TABLE settlement_intents
  ADD COLUMN direction text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
  ADD COLUMN observed_tx_ref text,
  ADD COLUMN observed_amount numeric(78, 0),
  ADD COLUMN observed_block bigint,
  ADD COLUMN observed_at timestamptz,
  ADD CONSTRAINT settlement_inbound_observed CHECK (direction = 'outbound' OR status NOT IN ('completed') OR (observed_tx_ref IS NOT NULL AND observed_amount IS NOT NULL));
CREATE UNIQUE INDEX settlement_intents_observed_tx_idx ON settlement_intents (network, observed_tx_ref) WHERE observed_tx_ref IS NOT NULL;

-- The investor's wallets this order uses, fixed when it is placed and screened.
ALTER TABLE rwa_orders
  ADD COLUMN investor_tron_address text,
  ADD COLUMN investor_solana_address text;
