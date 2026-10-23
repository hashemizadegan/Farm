/**
 * Marketplace (migration 0033), simulation only, behind MARKETPLACE_ENABLED (off: every route answers 404
 * `marketplace_not_enabled`; refused in production).
 *
 * The acting workspace is the one in the path; its member's role must hold the permission of what they do:
 * - browse the catalogue and a listing: any member (farm:read);
 * - list, withdraw, see eligible items, and every seller action on an order: market:sell;
 * - order or offer, and every buyer action: market:buy.
 * An order exists only for its two workspaces (404 for anyone else). Writes run in one system transaction that locks
 * the listing and the order, re-checks eligibility and control, and applies the order state machine; refusals are
 * 403 (not this party's action), 404, 409 (state, availability, control) or 422 (request).
 *
 * Nothing here moves money, a token, a title or a parcel: payment, refund, transfer of control and dispatch are records
 * on the platform. Every response carries `simulated: true`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  MarketError,
  actOnMarketOrder,
  createMarketListing,
  marketItemState,
  getMarketListing,
  getMarketOrder,
  listMarketListingOrders,
  listMarketListings,
  listMarketOrderEvents,
  listMarketOrders,
  placeMarketOrder,
  marketSellerCandidates,
  withSystem,
  withdrawMarketListing,
  type MarketListingRow,
  type MarketOrderEventRow,
  type MarketOrderRow,
} from "@metafarm/db";
import {
  MARKET_ITEM_KINDS,
  MARKET_SIMULATION_NOTICE,
  MARKET_ORDER_TRANSITIONS,
  availableOrderActions,
  can,
  createListingSchema,
  orderActionSchema,
  placeOrderSchema,
  uuid,
  type MarketOrderSide,
  type Permission,
} from "@metafarm/domain";
import { z } from "zod";
import { HttpError, forbidden, notFound, parse } from "../lib/http";

const tenantParams = z.object({ tenantId: uuid });
const listingParams = tenantParams.extend({ listingId: uuid });
const orderParams = tenantParams.extend({ orderId: uuid });

const iso = (d: Date | string) => new Date(d).toISOString();

export const toListing = (l: MarketListingRow, tenantId: string) => ({
  id: l.id,
  kind: l.kind,
  title: l.title,
  description: l.description,
  seller: { tenantId: l.tenant_id, name: l.seller_name },
  mine: l.tenant_id === tenantId,
  pricing: l.pricing,
  currency: l.currency,
  priceMinor: Number(l.price_minor),
  unit: l.unit,
  quantityListed: Number(l.quantity_listed),
  quantityAvailable: Number(l.quantity_available),
  deliveryOptions: l.delivery_options,
  status: l.status,
  provenance: l.eligibility,
  createdAt: iso(l.created_at),
  updatedAt: iso(l.updated_at),
  simulated: true as const,
});

const toOrder = (o: MarketOrderRow, tenantId: string) => {
  const side: MarketOrderSide = o.buyer_tenant_id === tenantId ? "buyer" : "seller";
  return {
    id: o.id,
    listingId: o.listing_id,
    listingTitle: o.listing_title,
    kind: o.kind,
    side,
    buyer: { tenantId: o.buyer_tenant_id, name: o.buyer_name, userName: o.buyer_user_name },
    seller: { tenantId: o.seller_tenant_id, name: o.seller_name },
    status: o.status,
    quantity: Number(o.quantity),
    unit: o.unit,
    currency: o.currency,
    unitPriceMinor: Number(o.unit_price_minor),
    subtotalMinor: Number(o.subtotal_minor),
    deliveryMinor: Number(o.delivery_minor),
    totalMinor: Number(o.total_minor),
    isOffer: o.is_offer,
    delivery: o.delivery_method ? { method: o.delivery_method, address: o.delivery_address, carrier: o.carrier, trackingRef: o.tracking_ref } : null,
    note: o.note,
    availableActions: availableOrderActions(o.kind, o.status, side),
    createdAt: iso(o.created_at),
    updatedAt: iso(o.updated_at),
    simulated: true as const,
  };
};

const toEvent = (e: MarketOrderEventRow) => ({
  id: e.id,
  actorSide: e.actor_side,
  actorName: e.actor_name,
  action: e.action,
  fromStatus: e.from_status,
  toStatus: e.to_status,
  detail: e.detail,
  at: iso(e.at),
});

export async function marketplaceRoutes(app: FastifyInstance) {
  const { env, pool } = app.deps;
  const enabled = () => {
    if (!env.MARKETPLACE_ENABLED) throw new HttpError(404, "marketplace_not_enabled", "the marketplace is not enabled on this deployment");
  };
  const market = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MarketError) throw new HttpError(err.status, err.code, err.message, err.details);
      throw err;
    }
  };
  /** Authenticates and authorises in the path's workspace; returns it and the member's role. */
  const actor = (req: FastifyRequest, permission: Permission) => app.inTenant(req, permission, async (_tx, ctx) => ctx);
  const actCtx = (req: FastifyRequest, tenantId: string) => ({ tenantId, userId: req.user!.id, requestId: req.id });

  async function orderDetail(req: FastifyRequest, tenantId: string, orderId: string) {
    return app.inTenant(req, "farm:read", async (tx) => {
      const o = await getMarketOrder(tx, orderId);
      if (!o) throw notFound("order");
      return { ...toOrder(o, tenantId), events: (await listMarketOrderEvents(tx, orderId)).map(toEvent), notice: MARKET_SIMULATION_NOTICE };
    });
  }

  app.get("/v1/tenants/:tenantId/market/listings", async (req) => {
    const { tenantId } = parse(tenantParams, req.params);
    enabled();
    const q = parse(z.object({ scope: z.enum(["catalogue", "mine"]).default("catalogue"), kind: z.enum(MARKET_ITEM_KINDS).optional() }).strict(), req.query);
    return app.inTenant(req, "farm:read", async (tx) => ({ items: (await listMarketListings(tx, q)).map((l) => toListing(l, tenantId)), notice: MARKET_SIMULATION_NOTICE }));
  });

  app.post("/v1/tenants/:tenantId/market/listings", async (req, reply) => {
    const { tenantId } = parse(tenantParams, req.params);
    enabled();
    const body = parse(createListingSchema, req.body);
    await actor(req, "market:sell");
    const id = await market(() => withSystem(pool, (tx) => createMarketListing(tx, actCtx(req, tenantId), body)));
    const row = await app.inTenant(req, "farm:read", async (tx) => (await getMarketListing(tx, id))!);
    return reply.status(201).send(toListing(row, tenantId));
  });

  app.get("/v1/tenants/:tenantId/market/listings/:listingId", async (req) => {
    const { tenantId, listingId } = parse(listingParams, req.params);
    enabled();
    const { listing, orders } = await app.inTenant(req, "farm:read", async (tx) => {
      const l = await getMarketListing(tx, listingId);
      if (!l) throw notFound("listing");
      return { listing: l, orders: await listMarketListingOrders(tx, listingId) };
    });
    // The item's current state, read across workspaces (status, control and voiding only): a buyer sees whether what
    // was checked at listing time still holds.
    const current = await withSystem(pool, (tx) => marketItemState(tx, listing));
    return {
      ...toListing(listing, tenantId),
      current,
      orders: orders.map((o) => toOrder(o, tenantId)),
      notice: MARKET_SIMULATION_NOTICE,
    };
  });

  app.post("/v1/tenants/:tenantId/market/listings/:listingId/withdraw", async (req) => {
    const { tenantId, listingId } = parse(listingParams, req.params);
    enabled();
    await actor(req, "market:sell");
    await market(() => withSystem(pool, (tx) => withdrawMarketListing(tx, actCtx(req, tenantId), listingId)));
    return app.inTenant(req, "farm:read", async (tx) => toListing((await getMarketListing(tx, listingId))!, tenantId));
  });

  app.get("/v1/tenants/:tenantId/market/eligible-items", async (req) => {
    const { tenantId } = parse(tenantParams, req.params);
    enabled();
    await actor(req, "market:sell");
    const c = await withSystem(pool, (tx) => marketSellerCandidates(tx, tenantId));
    return {
      assets: c.assets.map(({ originTenantId, ...a }) => ({ ...a, registeredHere: originTenantId === tenantId })),
      produce: c.produce,
      notice: MARKET_SIMULATION_NOTICE,
    };
  });

  app.get("/v1/tenants/:tenantId/market/orders", async (req) => {
    const { tenantId } = parse(tenantParams, req.params);
    enabled();
    const { side } = parse(z.object({ side: z.enum(["buyer", "seller"]) }).strict(), req.query);
    return app.inTenant(req, side === "buyer" ? "market:buy" : "market:sell", async (tx) => ({ items: (await listMarketOrders(tx, side)).map((o) => toOrder(o, tenantId)), notice: MARKET_SIMULATION_NOTICE }));
  });

  app.post("/v1/tenants/:tenantId/market/orders", async (req, reply) => {
    const { tenantId } = parse(tenantParams, req.params);
    enabled();
    const body = parse(placeOrderSchema, req.body);
    await actor(req, "market:buy");
    const id = await market(() => withSystem(pool, (tx) => placeMarketOrder(tx, actCtx(req, tenantId), body)));
    return reply.status(201).send(await orderDetail(req, tenantId, id));
  });

  app.get("/v1/tenants/:tenantId/market/orders/:orderId", async (req) => {
    const { tenantId, orderId } = parse(orderParams, req.params);
    enabled();
    const out = await orderDetail(req, tenantId, orderId);
    // Each side needs its own permission to see the order (addresses and amounts).
    if (!can(req.tenant!.role, out.side === "buyer" ? "market:buy" : "market:sell")) throw forbidden();
    return out;
  });

  app.post("/v1/tenants/:tenantId/market/orders/:orderId/actions", async (req) => {
    const { tenantId, orderId } = parse(orderParams, req.params);
    enabled();
    const body = parse(orderActionSchema, req.body);
    // The permission follows the side the action belongs to (cancel: either; the state machine decides).
    const t = MARKET_ORDER_TRANSITIONS[body.action];
    const ctx = await actor(req, "farm:read");
    const side = await app.inTenant(req, "farm:read", async (tx) => {
      const o = await getMarketOrder(tx, orderId);
      if (!o) throw notFound("order");
      return o.buyer_tenant_id === tenantId ? ("buyer" as const) : ("seller" as const);
    });
    if (body.action !== "cancel" && t.side !== side) throw new HttpError(403, "order_not_your_action", `${body.action} belongs to the ${t.side}`);
    if (!can(ctx.role, side === "buyer" ? "market:buy" : "market:sell")) throw forbidden();
    await market(() => withSystem(pool, (tx) => actOnMarketOrder(tx, actCtx(req, tenantId), orderId, body)));
    return orderDetail(req, tenantId, orderId);
  });
}
