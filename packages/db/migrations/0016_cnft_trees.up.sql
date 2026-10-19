-- Compressed NFTs (Bubblegum) in the database: the Merkle trees the platform mints into, tree
-- creation as its own chain operation, and registration orders, which record one-of-a-kind
-- assets (trees, parcels, animals) as a leaf held by a custodian party. Additive except that
-- an order's settlement columns become optional for registrations (no money moves).

-- ── Merkle trees ────────────────────────────────────────────────────────

CREATE TABLE merkle_trees (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  network           text NOT NULL CHECK (network IN ('solana-devnet', 'solana-mainnet')),
  status            text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'creating', 'active', 'full', 'failed', 'retired')),
  -- On-chain account, known once the creation transaction is prepared (its key is generated then).
  address           text CHECK (address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Shape chosen by planTree (packages/chain); fixed once the account exists.
  max_depth         smallint NOT NULL CHECK (max_depth BETWEEN 3 AND 30),
  max_buffer_size   integer NOT NULL CHECK (max_buffer_size BETWEEN 8 AND 2048),
  canopy_depth      smallint NOT NULL CHECK (canopy_depth >= 0),
  capacity          bigint NOT NULL CHECK (capacity > 0),
  -- The platform signer that created it; a private tree, so only it can mint.
  creator_address   text NOT NULL,
  -- Leaves whose mint is final. On-chain num_minted stays authoritative for the next leaf index.
  minted_count      bigint NOT NULL DEFAULT 0 CHECK (minted_count >= 0),
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT merkle_trees_shape CHECK (canopy_depth < max_depth AND capacity <= 2::numeric ^ max_depth),
  CONSTRAINT merkle_trees_room CHECK (minted_count <= capacity),
  CONSTRAINT merkle_trees_address_known CHECK (status IN ('planned', 'failed') OR address IS NOT NULL),
  CONSTRAINT merkle_trees_full CHECK (status <> 'full' OR minted_count = capacity)
);
CREATE UNIQUE INDEX merkle_trees_address_idx ON merkle_trees (network, address) WHERE address IS NOT NULL;
-- One tree in use per workspace and network: a new one is planned only when the last is full or failed.
CREATE UNIQUE INDEX merkle_trees_current_idx ON merkle_trees (tenant_id, network) WHERE status IN ('planned', 'creating', 'active');

CREATE FUNCTION merkle_trees_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Merkle trees are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.network IS DISTINCT FROM OLD.network
     OR NEW.creator_address IS DISTINCT FROM OLD.creator_address
     OR (OLD.address IS NOT NULL AND (NEW.address IS DISTINCT FROM OLD.address OR NEW.max_depth IS DISTINCT FROM OLD.max_depth
         OR NEW.max_buffer_size IS DISTINCT FROM OLD.max_buffer_size OR NEW.canopy_depth IS DISTINCT FROM OLD.canopy_depth
         OR NEW.capacity IS DISTINCT FROM OLD.capacity)) THEN
    RAISE EXCEPTION 'a Merkle tree''s identity and shape are fixed once it has an address' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.minted_count < OLD.minted_count THEN
    RAISE EXCEPTION 'minted_count never decreases' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('failed', 'retired') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a % tree stays %', OLD.status, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER merkle_trees_guard BEFORE UPDATE OR DELETE ON merkle_trees FOR EACH ROW EXECUTE FUNCTION merkle_trees_guard();

-- Creating a tree is a chain operation of its own (intent_type 'tree', intent_id = merkle_trees.id),
-- driven through the same lifecycle, transitions log and one-live-attempt rule as intents.
ALTER TABLE chain_operations DROP CONSTRAINT chain_operations_intent_type_check;
ALTER TABLE chain_operations ADD CONSTRAINT chain_operations_intent_type_check CHECK (intent_type IN ('issuance', 'settlement', 'tree'));

-- ── Leaves: representations and mints know their tree ──────────────────

ALTER TABLE asset_representations ADD COLUMN tree_id uuid,
  ADD CONSTRAINT asset_representations_tree_fk FOREIGN KEY (tenant_id, tree_id) REFERENCES merkle_trees(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT asset_representations_tree_rail CHECK (tree_id IS NULL OR rail = 'SOLANA_BUBBLEGUM_CNFT'),
  -- Lets an issuance intent prove (by foreign key) that its tree is its representation's tree.
  ADD CONSTRAINT asset_representations_tree_key UNIQUE (tenant_id, id, tree_id);
CREATE INDEX asset_representations_tree_idx ON asset_representations (tenant_id, tree_id) WHERE tree_id IS NOT NULL;

ALTER TABLE issuance_intents ADD COLUMN tree_id uuid,
  ADD CONSTRAINT issuance_intents_tree_fk FOREIGN KEY (tenant_id, representation_id, tree_id)
    REFERENCES asset_representations(tenant_id, id, tree_id),
  -- A compressed NFT is one of a kind: its mint is for exactly one.
  ADD CONSTRAINT issuance_intents_cnft_single CHECK (tree_id IS NULL OR action <> 'mint' OR amount = 1);

-- Filled from the representation, so a compressed mint can never be recorded without its tree.
CREATE FUNCTION issuance_intents_fill_tree() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT r.tree_id INTO NEW.tree_id FROM asset_representations r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.representation_id;
  RETURN NEW;
END $$;
CREATE TRIGGER issuance_intents_fill_tree BEFORE INSERT ON issuance_intents FOR EACH ROW EXECUTE FUNCTION issuance_intents_fill_tree();

-- The next leaf index is read from the tree (num_minted), so two mints in flight into one tree
-- would claim the same index: at most one live mint per tree.
CREATE UNIQUE INDEX issuance_intents_one_mint_per_tree_idx ON issuance_intents (tenant_id, tree_id)
  WHERE tree_id IS NOT NULL AND action = 'mint' AND status IN ('requested', 'approved', 'in_progress');

-- ── Registration orders ─────────────────────────────────────────────────

ALTER TABLE rwa_orders DROP CONSTRAINT rwa_orders_kind_check;
ALTER TABLE rwa_orders ADD CONSTRAINT rwa_orders_kind_check CHECK (kind IN ('subscription', 'redemption', 'distribution', 'registration'));
ALTER TABLE rwa_orders ALTER COLUMN settlement_network DROP NOT NULL,
  ALTER COLUMN token_contract DROP NOT NULL,
  ALTER COLUMN settlement_amount DROP NOT NULL,
  -- Money moves on every order except a registration, which mints exactly one leaf.
  ADD CONSTRAINT rwa_orders_settlement_presence CHECK (CASE WHEN kind = 'registration'
    THEN settlement_network IS NULL AND token_contract IS NULL AND settlement_amount IS NULL
    ELSE settlement_network IS NOT NULL AND token_contract IS NOT NULL AND settlement_amount IS NOT NULL END),
  ADD CONSTRAINT rwa_orders_registration_one_leaf CHECK (kind <> 'registration' OR (share_amount = 1 AND investor_tron_address IS NULL));

-- ── Row-level security and grants ──────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['merkle_trees'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_bypass ON %I TO CURRENT_USER USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON merkle_trees TO metafarm_app;
