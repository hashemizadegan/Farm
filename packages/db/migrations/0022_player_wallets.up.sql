-- J8: player wallets. A Solana wallet linked to a platform user (the game identity), after the user
-- proves control of it by signing a one-time, off-chain message in their own wallet. The platform
-- signs nothing and no transaction is involved.
--
-- Deliberately separate from party_wallets (migration 0012): an RWA party's wallet is a
-- compliance-screened relationship of a tenant's investor. Linking a player wallet never creates or
-- implies a party wallet, or the reverse; an address used in both domains has two explicit records,
-- each with its own consent and validation. Nothing here references party_wallets.
--
-- Like wallet_links, these tables are per user, not per tenant, and are not granted to metafarm_app:
-- tenant-scoped code cannot list them. The API reads them only for the signed-in user.

CREATE TABLE player_wallets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain      text NOT NULL CHECK (chain = 'solana'),
  -- An ed25519 public key in base58 (32 bytes: 32 to 44 characters). The same key on every cluster.
  address    text NOT NULL CHECK (address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  linked_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, address)
);
CREATE INDEX player_wallets_user_idx ON player_wallets (user_id);

-- One outstanding challenge per user and address; single use; the exact message is stored, so the
-- signature is checked against the bytes the server issued, not against a re-parsed message.
CREATE TABLE player_wallet_challenges (
  nonce       text PRIMARY KEY CHECK (length(nonce) BETWEEN 16 AND 128),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain       text NOT NULL CHECK (chain = 'solana'),
  address     text NOT NULL CHECK (address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  message     text NOT NULL CHECK (length(message) BETWEEN 1 AND 2048),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX player_wallet_challenges_user_idx ON player_wallet_challenges (user_id);
