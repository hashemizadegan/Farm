-- Y0 (real-yield plan revision 4; D-16 option A): verified cluster identity for ownership sources.
--
-- Ownership events and cursors (migration 0020) carried only a network *label*. An RPC endpoint pointed at
-- another cluster could have filled the index without a trace. Every RPC-sourced event and cursor now
-- references the cluster identity that was verified (getGenesisHash) before the batch that wrote it.
--
-- Stored per identity: the network label, the genesis hash the endpoint returned, and the endpoint as scheme
-- and host only. Credentials, tokens, paths, query strings and fragments are never stored: the host column
-- cannot hold '/', '?', '#', '@' or whitespace.
--
-- Fixture rows ('fixture' source) carry no identity and stay simulation-only (D-17).

CREATE TABLE ownership_source_identities (
  id               bigserial PRIMARY KEY,
  network          text NOT NULL CHECK (network IN ('solana-devnet', 'solana-mainnet')),
  genesis_hash     text NOT NULL CHECK (genesis_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  endpoint_scheme  text NOT NULL CHECK (endpoint_scheme IN ('https', 'http')),
  endpoint_host    text NOT NULL CHECK (endpoint_host ~ '^[a-z0-9.\-]{1,253}(:[0-9]{1,5})?$'),
  verified_at      timestamptz NOT NULL DEFAULT now(),
  verified_by      text NOT NULL CHECK (verified_by ~ '^[a-z0-9][a-z0-9._:\-]{0,63}$'),
  -- The last successful verification (each indexing batch re-verifies before writing).
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  -- A network label is bound to its cluster's genesis hash (Anza "Available Solana Clusters"; the same
  -- values as SOLANA_GENESIS_HASHES in packages/chain). A row cannot claim devnet with mainnet's hash.
  CONSTRAINT ownership_source_identities_genesis_check CHECK (
    (network = 'solana-devnet'  AND genesis_hash = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') OR
    (network = 'solana-mainnet' AND genesis_hash = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
  ),
  UNIQUE (network, genesis_hash, endpoint_scheme, endpoint_host),
  -- Target of the composite keys below: a row can only reference an identity of its own network.
  UNIQUE (id, network)
);

ALTER TABLE chain_ownership_events ADD COLUMN source_identity_id bigint;
ALTER TABLE chain_ownership_events
  ADD CONSTRAINT chain_ownership_events_identity_fkey FOREIGN KEY (source_identity_id, network) REFERENCES ownership_source_identities (id, network);
ALTER TABLE chain_ownership_cursors ADD COLUMN source_identity_id bigint;
ALTER TABLE chain_ownership_cursors
  ADD CONSTRAINT chain_ownership_cursors_identity_fkey FOREIGN KEY (source_identity_id, network) REFERENCES ownership_source_identities (id, network);

-- RPC rows must reference a verified identity; fixture rows must not. NOT VALID: enforced for every row
-- written from now on without failing on rows indexed before Y0. Readers ignore such unbound RPC rows
-- (packages/db readOwnershipIndex), so they are never served; the index can be rebuilt to replace them.
ALTER TABLE chain_ownership_events
  ADD CONSTRAINT chain_ownership_events_identity_check
  CHECK ((source = 'rpc' AND source_identity_id IS NOT NULL) OR (source = 'fixture' AND source_identity_id IS NULL)) NOT VALID;
ALTER TABLE chain_ownership_cursors
  ADD CONSTRAINT chain_ownership_cursors_identity_check
  CHECK ((source = 'rpc' AND source_identity_id IS NOT NULL) OR (source = 'fixture' AND source_identity_id IS NULL)) NOT VALID;

CREATE INDEX chain_ownership_events_source_identity_idx ON chain_ownership_events (source_identity_id);

-- Like the index itself: the indexer writes as the system role; the application role may only read.
GRANT SELECT ON ownership_source_identities TO metafarm_app;
