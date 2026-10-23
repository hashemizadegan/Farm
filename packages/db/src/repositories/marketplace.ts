/**
 * Marketplace (migration 0033; simulation only). Reads run in the caller's workspace (row-level security decides what
 * it may see). Writes run with a system transaction because a listing, an order and the control ledger span two
 * workspaces; every write function takes the acting workspace explicitly, locks the rows it changes, re-checks
 * eligibility, control and the order state machine (@metafarm/domain marketplace.ts), and appends to the order's audit
 * trail in the same transaction. A refusal is a MarketError (mapped to an HTTP status by the API).
 */
import {
  PUBLIC_LISTING_STATUSES,
  RELEASING_STATUSES,
  assetEligibility,
  deliveryEstimate,
  lineTotal,
  needsAddress,
  nextOrderStatus,
  produceEligibility,
  roundQty,
  type AssetIneligibility,
  type CreateListing,
  type DeliveryOption,
  type ListingStatus,
  type MarketCurrency,
  type MarketItemKind,
  type MarketOrderAction,
  type MarketOrderSide,
  type MarketOrderStatus,
  type PlaceOrder,
  type PricingMode,
  type ProduceIneligibility,
} from "@metafarm/domain";
import type { SystemTx, TenantTx } from "../tenant";

export class MarketError extends Error {
  constructor(
    public readonly status: 403 | 404 | 409 | 422,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "MarketError";
  }
}

// ── Rows ─────────────────────────────────────────────────────────────────

export interface MarketListingRow {
  id: string;
  tenant_id: string;
  seller_name: string;
  kind: MarketItemKind;
  asset_id: string | null;
  harvest_batch_id: string | null;
  title: string;
  description: string | null;
  pricing: PricingMode;
  currency: MarketCurrency;
  price_minor: string;
  unit: string;
  quantity_listed: string;
  quantity_available: string;
  delivery_options: DeliveryOption[];
  status: ListingStatus;
  eligibility: MarketListingProvenance;
  created_at: Date;
  updated_at: Date;
}

/** What was checked when the item was listed: shown to buyers as its provenance. */
export type MarketListingProvenance =
  | {
      kind: "registered_asset";
      assetName: string;
      assetKind: string;
      assetStatus: string;
      externalRef: string | null;
      farmName: string;
      verifiedAt: string | null;
      registeredBy: string;
      controlledBy: string;
      controlSource: "registration" | "marketplace_transfer";
      representations: { network: string; status: string }[];
      checks: string[];
    }
  | {
      kind: "produce";
      code: string;
      crop: string;
      harvestedOn: string;
      batchQuantity: number;
      unit: string;
      qualityGrade: string | null;
      recordHash: string;
      anchorStatus: string;
      farmName: string;
      producer: string;
      checks: string[];
    };

const LISTING_SELECT = `
  SELECT l.id, l.tenant_id, t.name AS seller_name, l.kind, l.asset_id, l.harvest_batch_id, l.title, l.description, l.pricing,
         l.currency, l.price_minor::text AS price_minor, l.unit, l.quantity_listed::text AS quantity_listed,
         l.quantity_available::text AS quantity_available, l.delivery_options, l.status, l.eligibility, l.created_at, l.updated_at
    FROM market_listings l JOIN tenants t ON t.id = l.tenant_id`;

export interface MarketOrderRow {
  id: string;
  listing_id: string;
  listing_title: string;
  kind: MarketItemKind;
  buyer_tenant_id: string;
  buyer_name: string;
  buyer_user_name: string | null;
  seller_tenant_id: string;
  seller_name: string;
  status: MarketOrderStatus;
  quantity: string;
  unit: string;
  currency: MarketCurrency;
  unit_price_minor: string;
  subtotal_minor: string;
  delivery_minor: string;
  total_minor: string;
  is_offer: boolean;
  delivery_method: string | null;
  delivery_address: Record<string, string> | null;
  carrier: string | null;
  tracking_ref: string | null;
  note: string | null;
  simulated: boolean;
  created_at: Date;
  updated_at: Date;
}

const ORDER_SELECT = `
  SELECT o.id, o.listing_id, l.title AS listing_title, o.kind, o.buyer_tenant_id, bt.name AS buyer_name,
         coalesce(bu.display_name, bu.email::text) AS buyer_user_name, o.seller_tenant_id, st.name AS seller_name, o.status,
         o.quantity::text AS quantity, o.unit, o.currency, o.unit_price_minor::text AS unit_price_minor,
         o.subtotal_minor::text AS subtotal_minor, o.delivery_minor::text AS delivery_minor, o.total_minor::text AS total_minor,
         o.is_offer, o.delivery_method, o.delivery_address, o.carrier, o.tracking_ref, o.note, o.simulated, o.created_at, o.updated_at
    FROM market_orders o
    JOIN market_listings l ON l.id = o.listing_id
    JOIN tenants bt ON bt.id = o.buyer_tenant_id
    JOIN tenants st ON st.id = o.seller_tenant_id
    LEFT JOIN users bu ON bu.id = o.buyer_user_id`;

export interface MarketOrderEventRow {
  id: string;
  actor_side: "buyer" | "seller" | "system";
  actor_name: string | null;
  action: string;
  from_status: string | null;
  to_status: string;
  detail: Record<string, unknown>;
  at: Date;
}

// ── Reads (the caller's workspace; row-level security applies) ──────────

/** The public catalogue (every workspace's active, reserved, sold-out and sold listings), or this workspace's own. */
export async function listMarketListings(tx: TenantTx, opts: { scope: "catalogue" | "mine"; kind?: MarketItemKind }): Promise<MarketListingRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.scope === "mine") {
    args.push(tx.tenantId);
    where.push(`l.tenant_id = $${args.length}`);
  } else {
    args.push(PUBLIC_LISTING_STATUSES);
    where.push(`l.status = ANY($${args.length}::text[])`);
  }
  if (opts.kind) {
    args.push(opts.kind);
    where.push(`l.kind = $${args.length}`);
  }
  // Active first, then most recent.
  return (await tx.query<MarketListingRow>(`${LISTING_SELECT} WHERE ${where.join(" AND ")} ORDER BY (l.status = 'active') DESC, l.created_at DESC LIMIT 200`, args)).rows;
}

export async function getMarketListing(tx: TenantTx | SystemTx, id: string): Promise<MarketListingRow | undefined> {
  return (await tx.query<MarketListingRow>(`${LISTING_SELECT} WHERE l.id = $1`, [id])).rows[0];
}

export async function listMarketOrders(tx: TenantTx, side: MarketOrderSide): Promise<MarketOrderRow[]> {
  const col = side === "buyer" ? "o.buyer_tenant_id" : "o.seller_tenant_id";
  return (await tx.query<MarketOrderRow>(`${ORDER_SELECT} WHERE ${col} = $1 ORDER BY o.updated_at DESC LIMIT 200`, [tx.tenantId])).rows;
}

export async function getMarketOrder(tx: TenantTx | SystemTx, id: string): Promise<MarketOrderRow | undefined> {
  return (await tx.query<MarketOrderRow>(`${ORDER_SELECT} WHERE o.id = $1`, [id])).rows[0];
}

export async function listMarketOrderEvents(tx: TenantTx | SystemTx, orderId: string): Promise<MarketOrderEventRow[]> {
  return (
    await tx.query<MarketOrderEventRow>(
      `SELECT e.id::text AS id, e.actor_side, coalesce(u.display_name, u.email::text) AS actor_name, e.action, e.from_status, e.to_status, e.detail, e.at
         FROM market_order_events e LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.order_id = $1 ORDER BY e.id`,
      [orderId],
    )
  ).rows;
}

/** Orders of a listing that this workspace may see (the seller sees all of them; a buyer its own). */
export async function listMarketListingOrders(tx: TenantTx, listingId: string): Promise<MarketOrderRow[]> {
  return (await tx.query<MarketOrderRow>(`${ORDER_SELECT} WHERE o.listing_id = $1 ORDER BY o.created_at DESC`, [listingId])).rows;
}

// ── What a workspace may list ────────────────────────────────────────────

export interface MarketAssetCandidate {
  id: string;
  name: string;
  kind: string;
  status: string;
  externalRef: string | null;
  farmName: string;
  originTenantId: string;
  controlSource: "registration" | "marketplace_transfer";
  eligible: boolean;
  reasons: AssetIneligibility[];
}

export interface MarketProduceCandidate {
  id: string;
  code: string;
  crop: string;
  harvestedOn: string;
  quantity: number;
  unit: string;
  available: number;
  voided: boolean;
  farmName: string;
  eligible: boolean;
  reasons: ProduceIneligibility[];
}

/**
 * Registered assets the workspace registered (and still controls, or has sold) or has acquired here, and its harvest
 * batches, each with its eligibility and the reasons when it is not eligible. System read: an acquired asset's record
 * stays in the workspace that registered it.
 */
export async function marketSellerCandidates(tx: SystemTx, tenantId: string, opts: { assetId?: string; batchId?: string; lock?: boolean } = {}): Promise<{ assets: MarketAssetCandidate[]; produce: MarketProduceCandidate[] }> {
  const lock = opts.lock ? "FOR UPDATE OF a" : "";
  const assets = (
    await tx.query<{
      id: string;
      name: string;
      kind: string;
      status: string;
      external_ref: string | null;
      farm_name: string;
      origin_tenant_id: string;
      controller: string;
      control_source: "registration" | "marketplace_transfer";
      mainnet: boolean;
      open_listing: boolean;
    }>(
      `SELECT a.id, a.name, a.kind, a.status, a.external_ref, f.name AS farm_name, a.tenant_id AS origin_tenant_id,
              coalesce(c.tenant_id, a.tenant_id) AS controller,
              CASE WHEN c.asset_id IS NULL THEN 'registration' ELSE 'marketplace_transfer' END AS control_source,
              EXISTS (SELECT 1 FROM asset_representations r WHERE r.asset_id = a.id AND r.network LIKE '%-mainnet') AS mainnet,
              EXISTS (SELECT 1 FROM market_listings l WHERE l.asset_id = a.id AND l.status IN ('active', 'reserved')) AS open_listing
         FROM business_assets a
         JOIN farms f ON f.tenant_id = a.tenant_id AND f.id = a.farm_id
         LEFT JOIN market_asset_control c ON c.asset_id = a.id
        WHERE (coalesce(c.tenant_id, a.tenant_id) = $1 OR a.tenant_id = $1)
          AND ($2::uuid IS NULL OR a.id = $2)
        ORDER BY a.created_at DESC
        LIMIT 500 ${lock}`,
      [tenantId, opts.assetId ?? null],
    )
  ).rows;
  const produce = (
    await tx.query<{
      id: string;
      code: string;
      crop_name: string;
      harvested_on: string;
      quantity: string;
      unit: string;
      voided: boolean;
      farm_name: string;
      committed: string;
    }>(
      `SELECT h.id, h.code, h.crop_name, to_char(h.harvested_on, 'YYYY-MM-DD') AS harvested_on, h.quantity::text AS quantity, h.unit,
              h.voided_at IS NOT NULL AS voided, f.name AS farm_name,
              -- Committed: the whole quantity of open listings, and what was sold (or is still on an order) from closed ones.
              coalesce((SELECT sum(CASE WHEN l.status IN ('active', 'reserved', 'sold_out') THEN l.quantity_listed
                                        ELSE l.quantity_listed - l.quantity_available END)
                          FROM market_listings l WHERE l.harvest_batch_id = h.id), 0)::text AS committed
         FROM harvest_batches h JOIN farms f ON f.tenant_id = h.tenant_id AND f.id = h.farm_id
        WHERE h.tenant_id = $1 AND ($2::uuid IS NULL OR h.id = $2)
        ORDER BY h.harvested_on DESC, h.created_at DESC
        LIMIT 500 ${opts.lock ? "FOR UPDATE OF h" : ""}`,
      [tenantId, opts.batchId ?? null],
    )
  ).rows;
  return {
    assets: assets.map((a) => {
      const e = assetEligibility({ kind: a.kind, status: a.status, controlledBySeller: a.controller === tenantId, hasMainnetRepresentation: a.mainnet, openListing: a.open_listing });
      return {
        id: a.id,
        name: a.name,
        kind: a.kind,
        status: a.status,
        externalRef: a.external_ref,
        farmName: a.farm_name,
        originTenantId: a.origin_tenant_id,
        controlSource: a.control_source,
        ...e,
      };
    }),
    produce: produce.map((p) => {
      const e = produceEligibility({ voided: p.voided, controlledBySeller: true, batchQuantity: Number(p.quantity), committedQuantity: Number(p.committed) });
      return {
        id: p.id,
        code: p.code,
        crop: p.crop_name,
        harvestedOn: p.harvested_on,
        quantity: Number(p.quantity),
        unit: p.unit,
        voided: p.voided,
        farmName: p.farm_name,
        ...e,
      };
    }),
  };
}

// ── Writes (system transaction, explicit workspace, re-checked) ──────────

async function tenantName(tx: SystemTx, id: string): Promise<string> {
  return (await tx.query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [id])).rows[0]?.name ?? "";
}

async function audit(tx: SystemTx, tenantId: string, userId: string | null, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>, requestId?: string) {
  await tx.query(
    `INSERT INTO audit_events (tenant_id, actor_user_id, actor_type, action, target_type, target_id, outcome, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, 'success', $7, $8::jsonb)`,
    [tenantId, userId, userId ? "user" : "system", action, targetType, targetId, requestId ?? null, JSON.stringify({ ...metadata, simulated: true })],
  );
}

export interface MarketActContext {
  tenantId: string;
  userId: string;
  requestId?: string;
}

export async function createMarketListing(tx: SystemTx, ctx: MarketActContext, input: CreateListing): Promise<string> {
  const seller = await tenantName(tx, ctx.tenantId);
  if (input.kind === "registered_asset") {
    const c = (await marketSellerCandidates(tx, ctx.tenantId, { assetId: input.assetId, lock: true })).assets[0];
    if (!c) throw new MarketError(404, "not_found", "asset not found");
    if (!c.eligible) throw new MarketError(409, "not_eligible", `this asset cannot be listed: ${c.reasons.join(", ")}`, { reasons: c.reasons });
    const a = (
      await tx.query<{ verified_at: Date | null; registered_by: string }>(
        `SELECT a.verified_at, t.name AS registered_by FROM business_assets a JOIN tenants t ON t.id = a.tenant_id WHERE a.id = $1`,
        [c.id],
      )
    ).rows[0]!;
    const representations = (await tx.query<{ network: string; status: string }>(`SELECT network, status FROM asset_representations WHERE asset_id = $1 ORDER BY created_at`, [c.id])).rows;
    const provenance: MarketListingProvenance = {
      kind: "registered_asset",
      assetName: c.name,
      assetKind: c.kind,
      assetStatus: c.status,
      externalRef: c.externalRef,
      farmName: c.farmName,
      verifiedAt: a.verified_at ? a.verified_at.toISOString() : null,
      registeredBy: a.registered_by,
      controlledBy: seller,
      controlSource: c.controlSource,
      representations,
      checks: ["verified", "controlled_by_seller", "no_mainnet_representation", "not_listed_elsewhere"],
    };
    try {
      await tx.query("SAVEPOINT listing");
      const id = (
        await tx.query<{ id: string }>(
          `INSERT INTO market_listings (tenant_id, kind, asset_id, title, description, pricing, currency, price_minor, unit, quantity_listed, quantity_available, eligibility, created_by)
           VALUES ($1, 'registered_asset', $2, $3, $4, $5, $6, $7, 'item', 1, 1, $8::jsonb, $9) RETURNING id`,
          [ctx.tenantId, c.id, input.title, input.description ?? null, input.pricing, input.currency, input.priceMinor, JSON.stringify(provenance), ctx.userId],
        )
      ).rows[0]!.id;
      await audit(tx, ctx.tenantId, ctx.userId, "market.listing_created", "market_listing", id, { kind: input.kind, assetId: c.id, priceMinor: input.priceMinor, currency: input.currency }, ctx.requestId);
      return id;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        await tx.query("ROLLBACK TO SAVEPOINT listing");
        throw new MarketError(409, "not_eligible", "this asset is already listed", { reasons: ["already_listed"] });
      }
      throw err;
    }
  }

  const c = (await marketSellerCandidates(tx, ctx.tenantId, { batchId: input.harvestBatchId, lock: true })).produce[0];
  if (!c) throw new MarketError(404, "not_found", "harvest batch not found");
  if (!c.eligible) throw new MarketError(409, "not_eligible", `this batch cannot be listed: ${c.reasons.join(", ")}`, { reasons: c.reasons });
  if (input.quantity > c.available + 1e-9) {
    throw new MarketError(409, "quantity_unavailable", `only ${c.available} ${c.unit} of this batch can still be listed`, { available: c.available });
  }
  const h = (
    await tx.query<{ quality_grade: string | null; record_hash: string; anchor_status: string; producer: string }>(
      `SELECT h.quality_grade, h.record_hash, h.anchor_status, t.name AS producer FROM harvest_batches h JOIN tenants t ON t.id = h.tenant_id WHERE h.id = $1`,
      [c.id],
    )
  ).rows[0]!;
  const provenance: MarketListingProvenance = {
    kind: "produce",
    code: c.code,
    crop: c.crop,
    harvestedOn: c.harvestedOn,
    batchQuantity: c.quantity,
    unit: c.unit,
    qualityGrade: h.quality_grade,
    recordHash: h.record_hash,
    anchorStatus: h.anchor_status,
    farmName: c.farmName,
    producer: h.producer,
    checks: ["batch_recorded", "not_voided", "quantity_within_batch"],
  };
  const id = (
    await tx.query<{ id: string }>(
      `INSERT INTO market_listings (tenant_id, kind, harvest_batch_id, title, description, pricing, currency, price_minor, unit, quantity_listed, quantity_available, delivery_options, eligibility, created_by)
       VALUES ($1, 'produce', $2, $3, $4, 'fixed', $5, $6, $7, $8, $8, $9::jsonb, $10::jsonb, $11) RETURNING id`,
      [ctx.tenantId, c.id, input.title, input.description ?? null, input.currency, input.priceMinor, c.unit, roundQty(input.quantity), JSON.stringify(input.deliveryOptions), JSON.stringify(provenance), ctx.userId],
    )
  ).rows[0]!.id;
  await audit(tx, ctx.tenantId, ctx.userId, "market.listing_created", "market_listing", id, { kind: input.kind, harvestBatchId: c.id, quantity: input.quantity, priceMinor: input.priceMinor, currency: input.currency }, ctx.requestId);
  return id;
}

async function lockListing(tx: SystemTx, id: string) {
  return (
    await tx.query<{
      id: string;
      tenant_id: string;
      kind: MarketItemKind;
      asset_id: string | null;
      harvest_batch_id: string | null;
      pricing: PricingMode;
      currency: MarketCurrency;
      price_minor: string;
      unit: string;
      quantity_listed: string;
      quantity_available: string;
      delivery_options: DeliveryOption[];
      status: ListingStatus;
    }>(
      `SELECT id, tenant_id, kind, asset_id, harvest_batch_id, pricing, currency, price_minor::text AS price_minor, unit,
              quantity_listed::text AS quantity_listed, quantity_available::text AS quantity_available, delivery_options, status
         FROM market_listings WHERE id = $1 FOR UPDATE`,
      [id],
    )
  ).rows[0];
}

async function appendEvent(tx: SystemTx, o: { id: string; buyer_tenant_id: string; seller_tenant_id: string }, e: { side: MarketOrderSide | "system"; userId: string | null; action: string; from: MarketOrderStatus | null; to: MarketOrderStatus; detail?: Record<string, unknown> }) {
  await tx.query(
    `INSERT INTO market_order_events (order_id, buyer_tenant_id, seller_tenant_id, actor_user_id, actor_side, action, from_status, to_status, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [o.id, o.buyer_tenant_id, o.seller_tenant_id, e.userId, e.side, e.action, e.from, e.to, JSON.stringify(e.detail ?? {})],
  );
}

/** Re-checks, at the moment it matters, that the seller still controls a registered asset and that it is still eligible. */
async function assertSellerStillControls(tx: SystemTx, sellerTenantId: string, assetId: string, listingId: string) {
  const c = (await marketSellerCandidates(tx, sellerTenantId, { assetId, lock: true })).assets[0];
  // The asset's own listing is open, which is expected here.
  const reasons = (c?.reasons ?? ["not_controlled_by_seller"]).filter((r) => r !== "already_listed");
  const own = await tx.query(`SELECT 1 FROM market_listings WHERE id = $1 AND asset_id = $2`, [listingId, assetId]);
  if (!c || reasons.length || !own.rowCount) throw new MarketError(409, "seller_no_longer_eligible", `the seller can no longer sell this asset: ${reasons.join(", ") || "listing changed"}`, { reasons });
}

export async function placeMarketOrder(tx: SystemTx, ctx: MarketActContext, input: PlaceOrder): Promise<string> {
  const l = await lockListing(tx, input.listingId);
  if (!l || !(PUBLIC_LISTING_STATUSES as readonly string[]).includes(l.status)) throw new MarketError(404, "not_found", "listing not found");
  if (l.tenant_id === ctx.tenantId) throw new MarketError(409, "own_listing", "a workspace cannot buy its own listing");
  if (l.status !== "active") throw new MarketError(409, "listing_unavailable", `the listing is ${l.status.replace("_", " ")}`);
  const price = Number(l.price_minor);

  let status: MarketOrderStatus;
  let quantity = 1;
  let unitPrice = price;
  let deliveryMinor = 0;
  let isOffer = false;
  let method: string | null = null;
  let address: unknown = null;

  if (l.kind === "registered_asset") {
    if (input.quantity !== undefined && input.quantity !== 1) throw new MarketError(422, "invalid_quantity", "a registered asset is sold whole (quantity 1)");
    if (input.delivery) throw new MarketError(422, "no_delivery", "a registered asset changes control on the platform; it has no delivery");
    await assertSellerStillControls(tx, l.tenant_id, l.asset_id!, l.id);
    if (l.pricing === "offers") {
      if (input.offerMinor === undefined) throw new MarketError(422, "offer_required", "this listing takes offers: say how much you offer");
      const open = await tx.query(`SELECT 1 FROM market_orders WHERE listing_id = $1 AND buyer_tenant_id = $2 AND status = 'offer_pending'`, [l.id, ctx.tenantId]);
      if (open.rowCount) throw new MarketError(409, "offer_exists", "your workspace already has an offer on this listing");
      isOffer = true;
      unitPrice = input.offerMinor;
      status = "offer_pending";
    } else {
      if (input.offerMinor !== undefined) throw new MarketError(422, "fixed_price", "this listing has a fixed price");
      status = "awaiting_payment";
      // Held for this buyer until paid, cancelled or refunded.
      await tx.query(`UPDATE market_listings SET status = 'reserved', updated_at = now() WHERE id = $1`, [l.id]);
    }
  } else {
    if (input.offerMinor !== undefined) throw new MarketError(422, "fixed_price", "produce is sold at the listed price");
    if (input.quantity === undefined) throw new MarketError(422, "quantity_required", "say how much you want");
    quantity = roundQty(input.quantity);
    const available = Number(l.quantity_available);
    if (quantity > available + 1e-9) throw new MarketError(409, "quantity_unavailable", `only ${available} ${l.unit} available`, { available });
    if (!input.delivery) throw new MarketError(422, "delivery_required", "choose how the produce reaches you");
    const est = deliveryEstimate(l.delivery_options, input.delivery.method, quantity);
    if (est === null) throw new MarketError(422, "delivery_unavailable", "the seller does not offer this delivery method");
    if (needsAddress(input.delivery.method) && !input.delivery.address) throw new MarketError(422, "address_required", "a delivery address is needed for this method");
    // A batch voided after listing cannot be sold.
    const batch = await tx.query<{ voided: boolean }>(`SELECT voided_at IS NOT NULL AS voided FROM harvest_batches WHERE id = $1`, [l.harvest_batch_id]);
    if (batch.rows[0]?.voided) throw new MarketError(409, "seller_no_longer_eligible", "the harvest batch was voided", { reasons: ["voided"] });
    deliveryMinor = est;
    method = input.delivery.method;
    address = needsAddress(input.delivery.method) ? input.delivery.address : null;
    status = "awaiting_payment";
    const left = roundQty(available - quantity);
    await tx.query(`UPDATE market_listings SET quantity_available = $2::numeric, status = CASE WHEN $2::numeric = 0 THEN 'sold_out' ELSE status END, updated_at = now() WHERE id = $1`, [l.id, left]);
  }

  const subtotal = lineTotal(unitPrice, quantity);
  const order = (
    await tx.query<{ id: string; buyer_tenant_id: string; seller_tenant_id: string }>(
      `INSERT INTO market_orders (listing_id, kind, buyer_tenant_id, buyer_user_id, seller_tenant_id, status, quantity, unit, currency, unit_price_minor,
                                  subtotal_minor, delivery_minor, total_minor, is_offer, delivery_method, delivery_address, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17)
       RETURNING id, buyer_tenant_id, seller_tenant_id`,
      [l.id, l.kind, ctx.tenantId, ctx.userId, l.tenant_id, status, quantity, l.unit, l.currency, unitPrice, subtotal, deliveryMinor, subtotal + deliveryMinor, isOffer, method, address ? JSON.stringify(address) : null, input.note ?? null],
    )
  ).rows[0]!;
  await appendEvent(tx, order, { side: "buyer", userId: ctx.userId, action: isOffer ? "offer" : "order", from: null, to: status, detail: { quantity, unitPriceMinor: unitPrice, deliveryMinor, method } });
  for (const t of [ctx.tenantId, l.tenant_id]) {
    await audit(tx, t, ctx.userId, isOffer ? "market.offer_placed" : "market.order_placed", "market_order", order.id, { listingId: l.id, quantity, totalMinor: subtotal + deliveryMinor, currency: l.currency }, ctx.requestId);
  }
  return order.id;
}

/** Gives back what an order held when it ends without completing. */
async function releaseHold(tx: SystemTx, listingId: string, kind: MarketItemKind, quantity: number, wasHolding: boolean) {
  if (!wasHolding) return;
  if (kind === "produce") {
    await tx.query(
      `UPDATE market_listings SET quantity_available = quantity_available + $2::numeric,
              status = CASE WHEN status = 'sold_out' THEN 'active' ELSE status END, updated_at = now()
        WHERE id = $1`,
      [listingId, quantity],
    );
  } else {
    await tx.query(`UPDATE market_listings SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'reserved'`, [listingId]);
  }
}

export interface MarketOrderActionInput {
  action: MarketOrderAction;
  carrier?: string;
  trackingRef?: string;
  note?: string;
}

export async function actOnMarketOrder(tx: SystemTx, ctx: MarketActContext, orderId: string, a: MarketOrderActionInput): Promise<void> {
  // Lock the listing first, then the order (the order placing path takes them in the same order).
  const head = (await tx.query<{ listing_id: string }>(`SELECT listing_id FROM market_orders WHERE id = $1`, [orderId])).rows[0];
  if (!head) throw new MarketError(404, "not_found", "order not found");
  const l = (await lockListing(tx, head.listing_id))!;
  const o = (
    await tx.query<{ id: string; kind: MarketItemKind; status: MarketOrderStatus; buyer_tenant_id: string; seller_tenant_id: string; quantity: string; is_offer: boolean; listing_id: string }>(
      `SELECT id, kind, status, buyer_tenant_id, seller_tenant_id, quantity::text AS quantity, is_offer, listing_id FROM market_orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    )
  ).rows[0]!;
  const side: MarketOrderSide | null = ctx.tenantId === o.buyer_tenant_id ? "buyer" : ctx.tenantId === o.seller_tenant_id ? "seller" : null;
  // Not a party: the order does not exist for this workspace.
  if (!side) throw new MarketError(404, "not_found", "order not found");
  const t = nextOrderStatus(o.kind, o.status, a.action, side);
  if (!t.ok) {
    throw new MarketError(t.reason === "not_your_action" ? 403 : 409, `order_${t.reason}`, `${a.action} is not possible for the ${side} of a ${o.kind.replace("_", " ")} order that is ${o.status.replace("_", " ")}`);
  }
  const quantity = Number(o.quantity);
  const detail: Record<string, unknown> = {};

  if (a.action === "accept") {
    if (l.status !== "active") throw new MarketError(409, "listing_unavailable", `the listing is ${l.status.replace("_", " ")}`);
    await assertSellerStillControls(tx, o.seller_tenant_id, l.asset_id!, l.id);
    await tx.query(`UPDATE market_listings SET status = 'reserved', updated_at = now() WHERE id = $1`, [l.id]);
    // Every other open offer on the listing is declined.
    const others = (await tx.query<{ id: string; buyer_tenant_id: string; seller_tenant_id: string }>(`SELECT id, buyer_tenant_id, seller_tenant_id FROM market_orders WHERE listing_id = $1 AND id <> $2 AND status = 'offer_pending' FOR UPDATE`, [l.id, o.id])).rows;
    for (const x of others) {
      await tx.query(`UPDATE market_orders SET status = 'declined', updated_at = now() WHERE id = $1`, [x.id]);
      await appendEvent(tx, x, { side: "system", userId: null, action: "decline", from: "offer_pending", to: "declined", detail: { reason: "another offer was accepted" } });
    }
  }
  if (a.action === "transfer") {
    await assertSellerStillControls(tx, o.seller_tenant_id, l.asset_id!, l.id);
    const origin = (await tx.query<{ tenant_id: string }>(`SELECT tenant_id FROM business_assets WHERE id = $1`, [l.asset_id])).rows[0]!.tenant_id;
    await tx.query(
      `INSERT INTO market_asset_control (asset_id, origin_tenant_id, tenant_id, acquired_order_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (asset_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, acquired_order_id = EXCLUDED.acquired_order_id, updated_at = now()`,
      [l.asset_id, origin, o.buyer_tenant_id, o.id],
    );
    await tx.query(`UPDATE market_listings SET status = 'sold', quantity_available = 0, updated_at = now() WHERE id = $1`, [l.id]);
    detail.controlledBy = await tenantName(tx, o.buyer_tenant_id);
  }
  if (a.action === "dispatch") {
    detail.carrier = a.carrier;
    detail.trackingRef = a.trackingRef;
    await tx.query(`UPDATE market_orders SET carrier = $2, tracking_ref = $3 WHERE id = $1`, [o.id, a.carrier, a.trackingRef]);
  }
  if (a.action === "confirm_receipt") {
    // Fully delivered: the listing is sold once nothing is left and no other order is still open.
    await tx.query(
      `UPDATE market_listings SET status = 'sold', updated_at = now()
        WHERE id = $1 AND status = 'sold_out'
          AND NOT EXISTS (SELECT 1 FROM market_orders WHERE listing_id = $1 AND id <> $2 AND status NOT IN ('delivered', 'transferred', 'declined', 'cancelled', 'refunded'))`,
      [l.id, o.id],
    );
  }
  if ((RELEASING_STATUSES as readonly string[]).includes(t.to)) {
    // Offers hold nothing; every other open order holds its quantity (produce) or the item (registered asset).
    await releaseHold(tx, l.id, o.kind, quantity, o.status !== "offer_pending");
  }
  if (a.note) detail.note = a.note;

  await tx.query(`UPDATE market_orders SET status = $2, updated_at = now() WHERE id = $1`, [o.id, t.to]);
  await appendEvent(tx, o, { side, userId: ctx.userId, action: a.action, from: o.status, to: t.to, detail });
  for (const tenant of [o.buyer_tenant_id, o.seller_tenant_id]) {
    await audit(tx, tenant, ctx.userId, `market.order_${a.action}`, "market_order", o.id, { from: o.status, to: t.to, side, ...detail }, ctx.requestId);
  }
}

export async function withdrawMarketListing(tx: SystemTx, ctx: MarketActContext, listingId: string): Promise<void> {
  const l = await lockListing(tx, listingId);
  if (!l || l.tenant_id !== ctx.tenantId) throw new MarketError(404, "not_found", "listing not found");
  if (l.status === "withdrawn" || l.status === "sold") throw new MarketError(409, "listing_closed", `the listing is already ${l.status}`);
  const holding = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM market_orders WHERE listing_id = $1 AND status IN ('awaiting_payment', 'paid', 'preparing', 'dispatched')`, [l.id])).rows[0]!.n;
  if (Number(holding) > 0) throw new MarketError(409, "listing_has_open_orders", "finish, cancel or refund the open orders before withdrawing the listing");
  const offers = (await tx.query<{ id: string; buyer_tenant_id: string; seller_tenant_id: string }>(`SELECT id, buyer_tenant_id, seller_tenant_id FROM market_orders WHERE listing_id = $1 AND status = 'offer_pending' FOR UPDATE`, [l.id])).rows;
  for (const x of offers) {
    await tx.query(`UPDATE market_orders SET status = 'declined', updated_at = now() WHERE id = $1`, [x.id]);
    await appendEvent(tx, x, { side: "system", userId: null, action: "decline", from: "offer_pending", to: "declined", detail: { reason: "the listing was withdrawn" } });
  }
  await tx.query(`UPDATE market_listings SET status = 'withdrawn', updated_at = now() WHERE id = $1`, [l.id]);
  await audit(tx, ctx.tenantId, ctx.userId, "market.listing_withdrawn", "market_listing", l.id, {}, ctx.requestId);
}

/** Registered assets this workspace controls through the marketplace (acquired here). */
export async function listMarketAcquiredAssets(tx: TenantTx): Promise<{ asset_id: string; acquired_order_id: string; updated_at: Date; title: string }[]> {
  return (
    await tx.query(
      `SELECT c.asset_id, c.acquired_order_id, c.updated_at, l.title
         FROM market_asset_control c JOIN market_orders o ON o.id = c.acquired_order_id JOIN market_listings l ON l.id = o.listing_id
        WHERE c.tenant_id = $1 ORDER BY c.updated_at DESC`,
      [tx.tenantId],
    )
  ).rows;
}

/** Current state of a listed item, read across workspaces (non-sensitive fields only) for the listing page. */
export async function marketItemState(tx: SystemTx, listing: Pick<MarketListingRow, "kind" | "asset_id" | "harvest_batch_id" | "tenant_id">): Promise<{ checks: Record<string, boolean>; controlledBy: string | null }> {
  if (listing.kind === "registered_asset") {
    const r = (
      await tx.query<{ status: string; controller: string; controller_name: string; mainnet: boolean }>(
        `SELECT a.status, coalesce(c.tenant_id, a.tenant_id) AS controller, t.name AS controller_name,
                EXISTS (SELECT 1 FROM asset_representations r WHERE r.asset_id = a.id AND r.network LIKE '%-mainnet') AS mainnet
           FROM business_assets a LEFT JOIN market_asset_control c ON c.asset_id = a.id JOIN tenants t ON t.id = coalesce(c.tenant_id, a.tenant_id)
          WHERE a.id = $1`,
        [listing.asset_id],
      )
    ).rows[0];
    if (!r) return { checks: {}, controlledBy: null };
    return {
      checks: { verified: r.status === "verified" || r.status === "active", controlledBySeller: r.controller === listing.tenant_id, noMainnetRepresentation: !r.mainnet },
      controlledBy: r.controller_name,
    };
  }
  const h = (await tx.query<{ voided: boolean }>(`SELECT voided_at IS NOT NULL AS voided FROM harvest_batches WHERE id = $1`, [listing.harvest_batch_id])).rows[0];
  return { checks: { batchRecorded: Boolean(h), notVoided: h ? !h.voided : false }, controlledBy: null };
}
