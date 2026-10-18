-- The signed transaction of an attempt, kept so it can be re-sent byte for byte (never re-signed)
-- until it lands or provably expires. Signed transactions are public once sent; no keys here.
ALTER TABLE chain_operations ADD COLUMN signed_wire text;
ALTER TABLE chain_operations ADD CONSTRAINT chain_operations_wire_with_ref CHECK (signed_wire IS NULL OR tx_ref IS NOT NULL);
