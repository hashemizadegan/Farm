-- Ownership index (digital twin, J7). Ownership events of Solana assets, read at finality, and how far
-- each asset has been indexed. Public chain data, not tenant-scoped (like chain_events). Holdings are not
-- stored: they are rebuilt from these events (packages/domain rebuildOwnership), so nothing here can be
-- edited to say something the chain did not. The indexer writes as the system role; the application role
-- may only read. The index is derived and can be dropped and rebuilt from the chain.

CREATE TABLE chain_ownership_events (
  id            bigserial PRIMARY KEY,
  network       text NOT NULL CHECK (network IN ('solana-devnet', 'solana-mainnet')),
  rail          text NOT NULL CHECK (rail IN ('SOLANA_TOKEN_2022', 'SOLANA_BUBBLEGUM_CNFT')),
  asset_id      text NOT NULL CHECK (asset_id ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  kind          text NOT NULL CHECK (kind IN ('mint', 'transfer', 'burn')),
  from_address  text CHECK (from_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  to_address    text CHECK (to_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  amount        numeric(20, 0) NOT NULL CHECK (amount > 0 AND amount <= 18446744073709551615),
  slot          bigint NOT NULL CHECK (slot >= 0),
  tx_index      integer NOT NULL CHECK (tx_index >= 0),
  ix_index      integer NOT NULL CHECK (ix_index >= 0),
  signature     text NOT NULL CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  source        text NOT NULL CHECK (source IN ('fixture', 'rpc')),
  indexed_at    timestamptz NOT NULL DEFAULT now()
);
-- The same event read twice is one row; a different event under the same (signature, instruction) is
-- kept, so the projection can report it as a conflict instead of it being silently dropped.
CREATE UNIQUE INDEX chain_ownership_events_identity_idx ON chain_ownership_events
  (network, signature, ix_index, rail, asset_id, kind, COALESCE(from_address, ''), COALESCE(to_address, ''), amount, slot, tx_index);
CREATE INDEX chain_ownership_events_asset_idx ON chain_ownership_events (network, rail, asset_id, slot);

CREATE TABLE chain_ownership_cursors (
  network               text NOT NULL CHECK (network IN ('solana-devnet', 'solana-mainnet')),
  rail                  text NOT NULL CHECK (rail IN ('SOLANA_TOKEN_2022', 'SOLANA_BUBBLEGUM_CNFT')),
  asset_id              text NOT NULL CHECK (asset_id ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Every finalized ownership event of the asset up to and including this slot is in chain_ownership_events.
  indexed_through_slot  bigint NOT NULL CHECK (indexed_through_slot >= 0),
  source                text NOT NULL CHECK (source IN ('fixture', 'rpc')),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, rail, asset_id)
);

GRANT SELECT ON chain_ownership_events, chain_ownership_cursors TO metafarm_app;
