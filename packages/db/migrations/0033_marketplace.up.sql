-- Marketplace (simulation only): listings of eligible items, orders between two workspaces, each order's audit
-- trail, and the platform's control ledger for registered assets. Nothing earlier is altered.
--
-- Nothing in these tables moves money, a token or a parcel: payments, refunds, transfers of control and dispatches are
-- recorded here for demonstration and are labelled "simulated" (`simulated` is fixed to true on every order).
--
-- Visibility (metafarm_app, row-level security):
-- - market_listings: the seller's workspace sees its own listings; every workspace sees listings in the public
--   catalogue (active, reserved, sold out, sold), never withdrawn ones of another workspace;
-- - market_orders and market_order_events: only the buyer's and the seller's workspaces;
-- - market_asset_control: the workspace that registered the asset and the one that now controls it.
-- The application role may only read. Every write goes through the API's checked paths (apps/api routes/marketplace.ts),
-- which lock the listing, re-check eligibility and control, and apply the order state machine
-- (packages/domain marketplace.ts) in one transaction.

CREATE TABLE market_listings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The seller's workspace.
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  kind                text NOT NULL CHECK (kind IN ('registered_asset', 'produce')),
  -- The item: a registered asset (in its registering workspace) or a harvest batch of the seller's workspace.
  asset_id            uuid REFERENCES business_assets(id) ON DELETE RESTRICT,
  harvest_batch_id    uuid REFERENCES harvest_batches(id) ON DELETE RESTRICT,
  title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  description         text CHECK (length(description) <= 2000),
  pricing             text NOT NULL CHECK (pricing IN ('fixed', 'offers')),
  currency            text NOT NULL CHECK (currency IN ('IRR', 'USD')),
  -- Minor units of the currency; per unit of quantity for produce.
  price_minor         bigint NOT NULL CHECK (price_minor > 0),
  unit                text NOT NULL CHECK (length(unit) BETWEEN 1 AND 16),
  quantity_listed     numeric(14, 3) NOT NULL CHECK (quantity_listed > 0),
  quantity_available  numeric(14, 3) NOT NULL CHECK (quantity_available >= 0),
  delivery_options    jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(delivery_options) = 'array'),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reserved', 'sold_out', 'sold', 'withdrawn')),
  -- The eligibility checks that passed when the item was listed (what the buyer is shown as provenance).
  eligibility         jsonb NOT NULL,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_listings_item CHECK (
    (kind = 'registered_asset' AND asset_id IS NOT NULL AND harvest_batch_id IS NULL AND quantity_listed = 1 AND unit = 'item' AND delivery_options = '[]'::jsonb)
    OR (kind = 'produce' AND harvest_batch_id IS NOT NULL AND asset_id IS NULL AND pricing = 'fixed' AND jsonb_array_length(delivery_options) BETWEEN 1 AND 3)
  ),
  CONSTRAINT market_listings_quantity CHECK (quantity_available <= quantity_listed)
);
CREATE INDEX market_listings_catalogue_idx ON market_listings (status, created_at DESC);
CREATE INDEX market_listings_tenant_idx ON market_listings (tenant_id, created_at DESC);
-- One open listing per registered asset at a time.
CREATE UNIQUE INDEX market_listings_open_asset_idx ON market_listings (asset_id) WHERE asset_id IS NOT NULL AND status IN ('active', 'reserved');

CREATE TABLE market_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id          uuid NOT NULL REFERENCES market_listings(id) ON DELETE RESTRICT,
  kind                text NOT NULL CHECK (kind IN ('registered_asset', 'produce')),
  buyer_tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  buyer_user_id       uuid NOT NULL REFERENCES users(id),
  seller_tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  status              text NOT NULL CHECK (status IN ('offer_pending', 'awaiting_payment', 'paid', 'preparing', 'dispatched', 'delivered', 'transferred', 'declined', 'cancelled', 'refunded')),
  quantity            numeric(14, 3) NOT NULL CHECK (quantity > 0),
  unit                text NOT NULL,
  currency            text NOT NULL CHECK (currency IN ('IRR', 'USD')),
  unit_price_minor    bigint NOT NULL CHECK (unit_price_minor > 0),
  subtotal_minor      bigint NOT NULL CHECK (subtotal_minor > 0),
  delivery_minor      bigint NOT NULL DEFAULT 0 CHECK (delivery_minor >= 0),
  total_minor         bigint NOT NULL CHECK (total_minor = subtotal_minor + delivery_minor),
  is_offer            boolean NOT NULL DEFAULT false,
  delivery_method     text CHECK (delivery_method IN ('pickup', 'local_delivery', 'courier_manual')),
  -- Shown only to the two workspaces of the order (row-level security).
  delivery_address    jsonb,
  carrier             text CHECK (length(carrier) <= 80),
  tracking_ref        text CHECK (length(tracking_ref) <= 64),
  note                text CHECK (length(note) <= 500),
  -- Every order of this table is a simulation: no payment, transfer or shipment happens outside the platform.
  simulated           boolean NOT NULL DEFAULT true CHECK (simulated),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_orders_two_parties CHECK (buyer_tenant_id <> seller_tenant_id),
  CONSTRAINT market_orders_kind CHECK (
    (kind = 'registered_asset' AND quantity = 1 AND delivery_method IS NULL AND delivery_minor = 0)
    OR (kind = 'produce' AND delivery_method IS NOT NULL AND NOT is_offer)
  ),
  CONSTRAINT market_orders_address CHECK (delivery_method IS NULL OR delivery_method = 'pickup' OR delivery_address IS NOT NULL),
  CONSTRAINT market_orders_dispatch CHECK (status NOT IN ('dispatched', 'delivered') OR (carrier IS NOT NULL AND tracking_ref IS NOT NULL))
);
CREATE INDEX market_orders_buyer_idx ON market_orders (buyer_tenant_id, created_at DESC);
CREATE INDEX market_orders_seller_idx ON market_orders (seller_tenant_id, created_at DESC);
CREATE INDEX market_orders_listing_idx ON market_orders (listing_id, status);

-- Append-only audit trail of every order: who did what, from which state to which.
CREATE TABLE market_order_events (
  id                  bigserial PRIMARY KEY,
  order_id            uuid NOT NULL REFERENCES market_orders(id) ON DELETE RESTRICT,
  buyer_tenant_id     uuid NOT NULL,
  seller_tenant_id    uuid NOT NULL,
  actor_user_id       uuid REFERENCES users(id),
  actor_side          text NOT NULL CHECK (actor_side IN ('buyer', 'seller', 'system')),
  action              text NOT NULL CHECK (length(action) BETWEEN 1 AND 40),
  from_status         text,
  to_status           text NOT NULL,
  detail              jsonb NOT NULL DEFAULT '{}'::jsonb,
  at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX market_order_events_order_idx ON market_order_events (order_id, id);
CREATE TRIGGER market_order_events_append_only BEFORE UPDATE OR DELETE ON market_order_events FOR EACH ROW EXECUTE FUNCTION append_only();

-- The platform's record of which workspace controls a registered asset once it has changed hands here. An asset with
-- no row is controlled by the workspace that registered it. Nothing on any chain or land registry changes.
CREATE TABLE market_asset_control (
  asset_id            uuid PRIMARY KEY REFERENCES business_assets(id) ON DELETE RESTRICT,
  origin_tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  acquired_order_id   uuid NOT NULL REFERENCES market_orders(id) ON DELETE RESTRICT,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE market_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_listings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON market_listings TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY catalogue_read ON market_listings FOR SELECT TO metafarm_app USING (status IN ('active', 'reserved', 'sold_out', 'sold'));
CREATE POLICY owner_bypass ON market_listings TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT ON market_listings TO metafarm_app;

ALTER TABLE market_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON market_orders TO metafarm_app
  USING (buyer_tenant_id = app_current_tenant() OR seller_tenant_id = app_current_tenant())
  WITH CHECK (buyer_tenant_id = app_current_tenant() OR seller_tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON market_orders TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT ON market_orders TO metafarm_app;

ALTER TABLE market_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_order_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON market_order_events TO metafarm_app
  USING (buyer_tenant_id = app_current_tenant() OR seller_tenant_id = app_current_tenant())
  WITH CHECK (buyer_tenant_id = app_current_tenant() OR seller_tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON market_order_events TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT ON market_order_events TO metafarm_app;

ALTER TABLE market_asset_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_asset_control FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON market_asset_control TO metafarm_app
  USING (tenant_id = app_current_tenant() OR origin_tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON market_asset_control TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT ON market_asset_control TO metafarm_app;
