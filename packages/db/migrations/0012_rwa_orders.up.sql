-- Parties (investors), their wallets, compliance screenings and orders. Every issuance and
-- settlement intent now belongs to an order, and the order says what the two legs should be.

CREATE TABLE parties (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  kind             text NOT NULL CHECK (kind IN ('person', 'organisation')),
  display_name     text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  -- ISO 3166-1 alpha-2 country of residence or incorporation.
  jurisdiction     text CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  kyc_status       text NOT NULL DEFAULT 'unverified' CHECK (kyc_status IN ('unverified', 'pending', 'verified', 'rejected')),
  -- The KYC provider's case reference (documents stay with the provider).
  kyc_reference    text,
  kyc_verified_at  timestamptz,
  kyc_expires_at   timestamptz,
  kyc_verified_by  uuid REFERENCES users(id),
  -- The member account, when the party is also a user of the workspace.
  user_id          uuid REFERENCES users(id),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (kyc_status <> 'verified' OR (kyc_verified_at IS NOT NULL AND kyc_reference IS NOT NULL))
);

CREATE TABLE party_wallets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  party_id    uuid NOT NULL,
  network     text NOT NULL CHECK (network IN ('solana-devnet', 'solana-mainnet', 'tron-nile', 'tron-shasta', 'tron-mainnet')),
  address     text NOT NULL CHECK (length(address) BETWEEN 20 AND 64),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- An address belongs to one party.
  UNIQUE (tenant_id, network, address),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE compliance_screenings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  subject             text NOT NULL CHECK (subject IN ('party', 'wallet')),
  party_id            uuid,
  wallet_id           uuid,
  -- Who screened and their reference: a real provider, never a hand-made list.
  provider            text NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
  provider_reference  text NOT NULL CHECK (length(provider_reference) BETWEEN 1 AND 200),
  outcome             text NOT NULL CHECK (outcome IN ('clear', 'review', 'blocked')),
  reasons             text[] NOT NULL DEFAULT '{}',
  checked_at          timestamptz NOT NULL,
  recorded_by         uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, wallet_id) REFERENCES party_wallets(tenant_id, id),
  CHECK ((subject = 'party') = (party_id IS NOT NULL AND wallet_id IS NULL)),
  CHECK ((subject = 'wallet') = (wallet_id IS NOT NULL AND party_id IS NULL))
);
CREATE INDEX compliance_screenings_party_idx ON compliance_screenings (tenant_id, party_id, checked_at DESC) WHERE party_id IS NOT NULL;
CREATE INDEX compliance_screenings_wallet_idx ON compliance_screenings (tenant_id, wallet_id, checked_at DESC) WHERE wallet_id IS NOT NULL;
CREATE TRIGGER compliance_screenings_append_only BEFORE UPDATE OR DELETE ON compliance_screenings FOR EACH ROW EXECUTE FUNCTION append_only();

CREATE TABLE rwa_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- Shared by the order's intents on both rails and by its reconciliation cases.
  reconciliation_id   uuid NOT NULL DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('subscription', 'redemption', 'distribution')),
  party_id            uuid NOT NULL,
  representation_id   uuid,
  share_amount        numeric(78, 0) CHECK (share_amount > 0),
  settlement_network  text NOT NULL CHECK (settlement_network IN ('tron-nile', 'tron-shasta', 'tron-mainnet')),
  token_contract      text NOT NULL,
  settlement_amount   numeric(78, 0) NOT NULL CHECK (settlement_amount > 0),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settling', 'issuing', 'completed', 'cancelled', 'exception')),
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, reconciliation_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, representation_id) REFERENCES asset_representations(tenant_id, id) ON DELETE RESTRICT,
  -- Distributions move money only; subscriptions and redemptions also move shares.
  CHECK ((kind = 'distribution') = (share_amount IS NULL)),
  CHECK (kind = 'distribution' OR representation_id IS NOT NULL)
);
CREATE INDEX rwa_orders_status_idx ON rwa_orders (tenant_id, status, created_at);

-- Intents and cases belong to an order; intents name the party they concern.
ALTER TABLE issuance_intents ADD COLUMN party_id uuid,
  ADD FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  ADD FOREIGN KEY (tenant_id, reconciliation_id) REFERENCES rwa_orders(tenant_id, reconciliation_id);
ALTER TABLE settlement_intents ADD COLUMN party_id uuid,
  ADD FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  ADD FOREIGN KEY (tenant_id, reconciliation_id) REFERENCES rwa_orders(tenant_id, reconciliation_id);
ALTER TABLE reconciliation_cases
  ADD FOREIGN KEY (tenant_id, reconciliation_id) REFERENCES rwa_orders(tenant_id, reconciliation_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['parties', 'party_wallets', 'compliance_screenings', 'rwa_orders'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_bypass ON %I TO CURRENT_USER USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON parties, party_wallets, rwa_orders TO metafarm_app;
GRANT SELECT, INSERT ON compliance_screenings TO metafarm_app;
