-- Financial records are retained: refuse to revert once trees or registrations exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM merkle_trees) OR EXISTS (SELECT 1 FROM rwa_orders WHERE kind = 'registration')
     OR EXISTS (SELECT 1 FROM chain_operations WHERE intent_type = 'tree') THEN
    RAISE EXCEPTION '0016 cannot be reverted: Merkle trees, tree operations or registration orders exist and must be retained';
  END IF;
END $$;

ALTER TABLE rwa_orders DROP CONSTRAINT rwa_orders_registration_one_leaf, DROP CONSTRAINT rwa_orders_settlement_presence,
  ALTER COLUMN settlement_amount SET NOT NULL, ALTER COLUMN token_contract SET NOT NULL, ALTER COLUMN settlement_network SET NOT NULL;
ALTER TABLE rwa_orders DROP CONSTRAINT rwa_orders_kind_check;
ALTER TABLE rwa_orders ADD CONSTRAINT rwa_orders_kind_check CHECK (kind IN ('subscription', 'redemption', 'distribution'));

DROP INDEX issuance_intents_one_mint_per_tree_idx;
DROP TRIGGER issuance_intents_fill_tree ON issuance_intents;
DROP FUNCTION issuance_intents_fill_tree();
ALTER TABLE issuance_intents DROP CONSTRAINT issuance_intents_cnft_single, DROP CONSTRAINT issuance_intents_tree_fk, DROP COLUMN tree_id;

DROP INDEX asset_representations_tree_idx;
ALTER TABLE asset_representations DROP CONSTRAINT asset_representations_tree_key, DROP CONSTRAINT asset_representations_tree_rail,
  DROP CONSTRAINT asset_representations_tree_fk, DROP COLUMN tree_id;

ALTER TABLE chain_operations DROP CONSTRAINT chain_operations_intent_type_check;
ALTER TABLE chain_operations ADD CONSTRAINT chain_operations_intent_type_check CHECK (intent_type IN ('issuance', 'settlement'));

DROP TRIGGER merkle_trees_guard ON merkle_trees;
DROP FUNCTION merkle_trees_guard();
DROP TABLE merkle_trees;
