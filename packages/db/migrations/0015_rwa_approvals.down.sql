ALTER TABLE rwa_orders DROP CONSTRAINT IF EXISTS rwa_orders_approval_pair, DROP CONSTRAINT IF EXISTS rwa_orders_four_eyes,
  DROP COLUMN IF EXISTS approved_at, DROP COLUMN IF EXISTS approved_by;
