-- Money or shares leaving the platform (redemptions, distributions) need a second person's approval.
ALTER TABLE rwa_orders
  ADD COLUMN approved_by uuid REFERENCES users(id),
  ADD COLUMN approved_at timestamptz,
  ADD CONSTRAINT rwa_orders_four_eyes CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM created_by),
  ADD CONSTRAINT rwa_orders_approval_pair CHECK ((approved_by IS NULL) = (approved_at IS NULL));
