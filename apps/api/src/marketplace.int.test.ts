/**
 * Marketplace against a real database (simulation only): eligibility for registered assets and produce, listing only
 * what the workspace controls, the catalogue across workspaces, orders and offers between two workspaces, the full
 * order state machine (payment, transfer of control, preparation, manual dispatch, receipt, cancellation, refund),
 * quantity and control invariants under every path, authorization by role and by party, visibility (an order exists
 * only for its two workspaces), and the audit trail. Nothing moves money, a token or a parcel.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("marketplace (simulation)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { seller: `mk-s-${sfx}`, sellerViewer: `mk-sv-${sfx}`, verifier: `mk-v-${sfx}`, buyer: `mk-b-${sfx}`, other: `mk-o-${sfx}` };
  const ids: Record<string, string> = {};
  let S: string; // seller workspace
  let B: string; // buyer workspace
  let O: string; // a third workspace
  let farm: string;
  const asset: Record<string, string> = {};
  const batch: Record<string, string> = {};
  const auth = async (who: keyof typeof subjects) => ({ authorization: `Bearer ${await tokenFor(subjects[who])}` });
  const req = async (who: keyof typeof subjects, method: "GET" | "POST", path: string, payload?: unknown) =>
    app.inject({ method, url: path, headers: await auth(who), ...(payload === undefined ? {} : { payload: payload as object }) });
  const address = { recipient: "Buyer (simulation)", line1: "1 Test Street", city: "Isfahan", postalCode: "81000", country: "ir", phone: "+98 31 0000 0000" };
  const produceListing = (harvestBatchId: string, quantity: number) => ({
    kind: "produce",
    harvestBatchId,
    quantity,
    priceMinor: 4_500_000,
    currency: "IRR",
    title: "Pistachios (simulation)",
    deliveryOptions: [
      { method: "pickup", feeMinor: 0, perUnitMinor: 0 },
      { method: "courier_manual", feeMinor: 2_500_000, perUnitMinor: 50_000 },
    ],
  });
  const listingOf = async (id: string) => (await pool.query<{ status: string; quantity_available: string }>(`SELECT status, quantity_available::text FROM market_listings WHERE id = $1`, [id])).rows[0]!;
  const act = (who: keyof typeof subjects, tenant: string, orderId: string, body: Record<string, unknown>) => req(who, "POST", `/v1/tenants/${tenant}/market/orders/${orderId}/actions`, body);

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 8 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s, name: k })).id;
    S = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `mk-s-${sfx}`, name: "Seller farm", ownerUserId: ids.seller! }));
    B = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `mk-b-${sfx}`, name: "Buyer co", ownerUserId: ids.buyer! }));
    O = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `mk-o-${sfx}`, name: "Third party", ownerUserId: ids.other! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'viewer'), ($1, $3, 'verifier')`, [S, ids.sellerViewer, ids.verifier]);
    app = (await buildTestApp({ pool, env: { MARKETPLACE_ENABLED: "true" } })).app;
    farm = (await req("seller", "POST", `/v1/tenants/${S}/farms`, { name: "Grove" })).json().id;
    for (const [k, crop, qty] of [["pistachio", "Pistachios", "120"], ["saffron", "Saffron", "0.5"], ["walnut", "Walnuts", "50"]] as const) {
      const r = await req("seller", "POST", `/v1/tenants/${S}/farms/${farm}/harvests`, { cropName: crop, quantity: qty, unit: "kg", harvestedOn: "2026-10-01" });
      expect(r.statusCode, r.body).toBe(201);
      batch[k] = r.json().id;
    }
    await req("seller", "POST", `/v1/tenants/${S}/farms/${farm}/harvests/${batch.walnut}/void`, { reason: "duplicate entry" });
    await withSystem(pool, async (tx) => {
      const mk = async (kind: string, name: string, status: string) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO business_assets (tenant_id, farm_id, kind, name, status, verified_by, verified_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [S, farm, kind, name, status, status === "draft" ? null : ids.verifier, status === "draft" ? null : new Date(), ids.seller],
          )
        ).rows[0]!.id;
      asset.ewe = await mk("livestock", "Ewe", "verified");
      asset.kit = await mk("equipment", "Drip kit", "verified");
      asset.draft = await mk("livestock", "Ram", "draft");
      asset.lot = await mk("harvest_lot", "Lot", "verified");
      asset.mainnet = await mk("farm_share", "Share", "verified");
      await tx.query(`INSERT INTO asset_representations (tenant_id, asset_id, rail, network) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'solana-mainnet')`, [S, asset.mainnet]);
    });
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("is off unless MARKETPLACE_ENABLED", async () => {
    const off = (await buildTestApp({ pool })).app;
    const r = await off.inject({ method: "GET", url: `/v1/tenants/${S}/market/listings`, headers: await auth("seller") });
    expect([r.statusCode, r.json().error]).toEqual([404, "marketplace_not_enabled"]);
    await off.close();
  });

  it("reports each item's eligibility with its reasons", async () => {
    const r = await req("seller", "GET", `/v1/tenants/${S}/market/eligible-items`);
    expect(r.statusCode).toBe(200);
    const byName = Object.fromEntries(r.json().assets.map((a: { name: string; reasons: string[] }) => [a.name, a.reasons]));
    expect(byName).toEqual({ Ewe: [], "Drip kit": [], Ram: ["not_verified"], Lot: ["kind_not_listable"], Share: ["mainnet_representation"] });
    const produce = Object.fromEntries(r.json().produce.map((p: { crop: string; reasons: string[]; available: number }) => [p.crop, [p.reasons, p.available]]));
    expect(produce).toEqual({ Pistachios: [[], 120], Saffron: [[], 0.5], Walnuts: [["voided"], 50] });
    // Viewers cannot sell, and the buyer's workspace has nothing of the seller's.
    expect((await req("sellerViewer", "GET", `/v1/tenants/${S}/market/eligible-items`)).statusCode).toBe(403);
    expect((await req("buyer", "GET", `/v1/tenants/${B}/market/eligible-items`)).json().assets).toEqual([]);
  });

  it("lists only eligible items the workspace controls, never another workspace's, and never more than the batch", async () => {
    const draft = await req("seller", "POST", `/v1/tenants/${S}/market/listings`, { kind: "registered_asset", assetId: asset.draft, pricing: "fixed", priceMinor: 1, currency: "IRR", title: "Ram" });
    expect([draft.statusCode, draft.json().error, draft.json().details.reasons]).toEqual([409, "not_eligible", ["not_verified"]]);
    const voided = await req("seller", "POST", `/v1/tenants/${S}/market/listings`, produceListing(batch.walnut!, 1));
    expect([voided.statusCode, voided.json().details.reasons]).toEqual([409, ["voided"]]);
    const tooMuch = await req("seller", "POST", `/v1/tenants/${S}/market/listings`, produceListing(batch.pistachio!, 120.5));
    expect([tooMuch.statusCode, tooMuch.json().error]).toEqual([409, "quantity_unavailable"]);
    // The buyer cannot list the seller's asset or batch: not theirs (404, nothing revealed).
    expect((await req("buyer", "POST", `/v1/tenants/${B}/market/listings`, { kind: "registered_asset", assetId: asset.ewe, pricing: "fixed", priceMinor: 1, currency: "IRR", title: "x" })).statusCode).toBe(404);
    expect((await req("buyer", "POST", `/v1/tenants/${B}/market/listings`, produceListing(batch.pistachio!, 1))).statusCode).toBe(404);
    // A viewer of the seller's workspace cannot list.
    expect((await req("sellerViewer", "POST", `/v1/tenants/${S}/market/listings`, produceListing(batch.pistachio!, 1))).statusCode).toBe(403);
  });

  it("takes produce from order to confirmed delivery; quantity is reserved, released on cancellation and refund, and never oversold", async () => {
    const l = await req("seller", "POST", `/v1/tenants/${S}/market/listings`, produceListing(batch.pistachio!, 80));
    expect(l.statusCode, l.body).toBe(201);
    const listingId = l.json().id;
    // The rest of the batch is all that can still be listed.
    expect((await req("seller", "POST", `/v1/tenants/${S}/market/listings`, produceListing(batch.pistachio!, 41))).json().error).toBe("quantity_unavailable");

    // Seen by every workspace in the catalogue.
    const cat = (await req("other", "GET", `/v1/tenants/${O}/market/listings?kind=produce`)).json().items;
    expect(cat.map((x: { id: string }) => x.id)).toContain(listingId);

    // Own listing: refused. Missing address for a shipped method, or an unoffered method: refused.
    expect((await req("seller", "POST", `/v1/tenants/${S}/market/orders`, { listingId, quantity: 1, delivery: { method: "pickup" } })).json().error).toBe("own_listing");
    expect((await req("buyer", "POST", `/v1/tenants/${B}/market/orders`, { listingId, quantity: 1, delivery: { method: "courier_manual" } })).json().error).toBe("address_required");
    expect((await req("buyer", "POST", `/v1/tenants/${B}/market/orders`, { listingId, quantity: 1, delivery: { method: "local_delivery", address } })).json().error).toBe("delivery_unavailable");
    expect((await req("buyer", "POST", `/v1/tenants/${B}/market/orders`, { listingId, quantity: 81, delivery: { method: "pickup" } })).json().error).toBe("quantity_unavailable");

    const placed = await req("buyer", "POST", `/v1/tenants/${B}/market/orders`, { listingId, quantity: 2.5, delivery: { method: "courier_manual", address } });
    expect(placed.statusCode, placed.body).toBe(201);
    const o = placed.json();
    expect([o.status, o.subtotalMinor, o.deliveryMinor, o.totalMinor, o.simulated, o.side]).toEqual(["awaiting_payment", 11_250_000, 2_625_000, 13_875_000, true, "buyer"]);
    expect(o.delivery.address.country).toBe("IR");
    expect((await listingOf(listingId)).quantity_available).toBe("77.500");

    // Only the two parties see the order; the third workspace gets 404 everywhere.
    expect((await req("other", "GET", `/v1/tenants/${O}/market/orders/${o.id}`)).statusCode).toBe(404);
    expect((await act("other", O, o.id, { action: "pay" })).statusCode).toBe(404);
    // The seller's viewer has no market:sell: 403.
    expect((await req("sellerViewer", "GET", `/v1/tenants/${S}/market/orders/${o.id}`)).statusCode).toBe(403);

    // Wrong party, wrong state.
    expect((await act("seller", S, o.id, { action: "pay" })).statusCode).toBe(403);
    expect((await act("seller", S, o.id, { action: "dispatch", carrier: "Courier", trackingRef: "AB-1" })).statusCode).toBe(409);
    expect((await act("buyer", B, o.id, { action: "pay" })).json().status).toBe("paid");
    expect((await act("buyer", B, o.id, { action: "cancel" })).statusCode).toBe(409);
    expect((await act("seller", S, o.id, { action: "prepare" })).json().status).toBe("preparing");
    expect((await act("seller", S, o.id, { action: "dispatch" })).statusCode).toBe(400);
    const dispatched = (await act("seller", S, o.id, { action: "dispatch", carrier: "Manual courier", trackingRef: "MC-2026-001" })).json();
    expect([dispatched.status, dispatched.delivery.carrier, dispatched.delivery.trackingRef]).toEqual(["dispatched", "Manual courier", "MC-2026-001"]);
    expect((await act("seller", S, o.id, { action: "refund" })).statusCode).toBe(409);
    expect((await act("seller", S, o.id, { action: "confirm_receipt" })).statusCode).toBe(403);
    const done = (await act("buyer", B, o.id, { action: "confirm_receipt" })).json();
    expect(done.status).toBe("delivered");
    expect(done.availableActions).toEqual([]);
    expect(done.events.map((e: { action: string; toStatus: string; actorSide: string }) => `${e.actorSide}:${e.action}:${e.toStatus}`)).toEqual([
      "buyer:order:awaiting_payment",
      "buyer:pay:paid",
      "seller:prepare:preparing",
      "seller:dispatch:dispatched",
      "buyer:confirm_receipt:delivered",
    ]);
    expect((await listingOf(listingId)).quantity_available).toBe("77.500");

    // Cancellation (unpaid, by either party) and refund (paid, by the seller) give the quantity back.
    const c1 = (await req("buyer", "POST", `/v1/tenants/${B}/market/orders`, { listingId, quantity: 10, delivery: { method: "pickup" } })).json();
    expect((await listingOf(listingId)).quantity_available).toBe("67.500");
    expect((await act("seller", S, c1.id, { action: "cancel" })).json().status).toBe("cancelled");
    expect((await listingOf(listingId)).quantity_available).toBe("77.500");
    const r1 = (await req("buyer", "POST", `/v1/tenants/${B}/market/orders`, { listingId, quantity: 77.5, delivery: { method: "pickup" } })).json();
    expect(await listingOf(listingId)).toEqual({ status: "sold_out", quantity_available: "0.000" });
    // Sold out: nobody can order more.
    expect((await req("other", "POST", `/v1/tenants/${O}/market/orders`, { listingId, quantity: 1, delivery: { method: "pickup" } })).json().error).toBe("listing_unavailable");
    await act("buyer", B, r1.id, { action: "pay" });
    expect((await act("seller", S, r1.id, { action: "refund" })).json().status).toBe("refunded");
    expect(await listingOf(listingId)).toEqual({ status: "active", quantity_available: "77.500" });

    // Both workspaces' audit trails record the order.
    const audit = (await pool.query<{ tenant_id: string; action: string }>(`SELECT tenant_id, action FROM audit_events WHERE target_type = 'market_order' AND target_id = $1 ORDER BY id`, [o.id])).rows;
    expect(audit.filter((a) => a.tenant_id === S).map((a) => a.action)).toEqual(["market.order_placed", "market.order_pay", "market.order_prepare", "market.order_dispatch", "market.order_confirm_receipt"]);
    expect(audit.filter((a) => a.tenant_id === B)).toHaveLength(5);
  });

  it("concurrent orders never sell more than is available", async () => {
    const l = (await req("seller", "POST", `/v1/tenants/${S}/market/listings`, produceListing(batch.saffron!, 0.5))).json();
    const tries = await Promise.all(Array.from({ length: 6 }, () => req("buyer", "POST", `/v1/tenants/${B}/market/orders`, { listingId: l.id, quantity: 0.1, delivery: { method: "pickup" } })));
    expect(tries.filter((r) => r.statusCode === 201)).toHaveLength(5);
    expect(tries.filter((r) => r.statusCode === 409)).toHaveLength(1);
    expect(await listingOf(l.id)).toEqual({ status: "sold_out", quantity_available: "0.000" });
  });

  it("sells a registered asset by offer: accept declines the others, payment, recorded transfer of control; then only the new controller can list it", async () => {
    const l = (await req("seller", "POST", `/v1/tenants/${S}/market/listings`, { kind: "registered_asset", assetId: asset.kit, pricing: "offers", priceMinor: 180_000_000, currency: "IRR", title: "Drip kit" })).json();
    expect(l.provenance).toMatchObject({ kind: "registered_asset", assetName: "Drip kit", assetStatus: "verified", controlledBy: "Seller farm", controlSource: "registration" });
    // Listed once only.
    expect((await req("seller", "POST", `/v1/tenants/${S}/market/listings`, { kind: "registered_asset", assetId: asset.kit, pricing: "fixed", priceMinor: 1, currency: "IRR", title: "again" })).json().details.reasons).toEqual(["already_listed"]);

    expect((await req("buyer", "POST", `/v1/tenants/${B}/market/orders`, { listingId: l.id })).json().error).toBe("offer_required");
    expect((await req("buyer", "POST", `/v1/tenants/${B}/market/orders`, { listingId: l.id, offerMinor: 150_000_000, delivery: { method: "pickup" } })).json().error).toBe("no_delivery");
    const offerB = (await req("buyer", "POST", `/v1/tenants/${B}/market/orders`, { listingId: l.id, offerMinor: 150_000_000 })).json();
    const offerO = (await req("other", "POST", `/v1/tenants/${O}/market/orders`, { listingId: l.id, offerMinor: 140_000_000 })).json();
    expect([offerB.status, offerB.isOffer, offerB.totalMinor]).toEqual(["offer_pending", true, 150_000_000]);
    expect((await req("buyer", "POST", `/v1/tenants/${B}/market/orders`, { listingId: l.id, offerMinor: 160_000_000 })).json().error).toBe("offer_exists");
    // An offer holds nothing: the listing stays active until the seller accepts.
    expect((await listingOf(l.id)).status).toBe("active");
    // The buyer cannot accept their own offer.
    expect((await act("buyer", B, offerB.id, { action: "accept" })).statusCode).toBe(403);

    const accepted = (await act("seller", S, offerB.id, { action: "accept" })).json();
    expect(accepted.status).toBe("awaiting_payment");
    expect((await listingOf(l.id)).status).toBe("reserved");
    const declined = (await req("other", "GET", `/v1/tenants/${O}/market/orders/${offerO.id}`)).json();
    expect([declined.status, declined.events.at(-1).actorSide]).toEqual(["declined", "system"]);

    expect((await act("buyer", B, offerB.id, { action: "pay" })).json().status).toBe("paid");
    // Transfer is the seller's: the buyer cannot take control.
    expect((await act("buyer", B, offerB.id, { action: "transfer" })).statusCode).toBe(403);
    const transferred = (await act("seller", S, offerB.id, { action: "transfer" })).json();
    expect([transferred.status, transferred.events.at(-1).detail.controlledBy]).toEqual(["transferred", "Buyer co"]);
    expect((await listingOf(l.id)).status).toBe("sold");
    expect((await pool.query(`SELECT tenant_id, origin_tenant_id FROM market_asset_control WHERE asset_id = $1`, [asset.kit])).rows).toEqual([{ tenant_id: B, origin_tenant_id: S }]);

    // The original registrant no longer controls it: it cannot list it again.
    const sellerView = (await req("seller", "GET", `/v1/tenants/${S}/market/eligible-items`)).json().assets.find((a: { id: string }) => a.id === asset.kit);
    expect(sellerView.reasons).toEqual(["not_controlled_by_seller"]);
    expect((await req("seller", "POST", `/v1/tenants/${S}/market/listings`, { kind: "registered_asset", assetId: asset.kit, pricing: "fixed", priceMinor: 1, currency: "IRR", title: "mine?" })).json().details.reasons).toEqual(["not_controlled_by_seller"]);
    // The new controller can, and its listing says so.
    const buyerView = (await req("buyer", "GET", `/v1/tenants/${B}/market/eligible-items`)).json().assets;
    expect(buyerView.map((a: { id: string; eligible: boolean; controlSource: string; registeredHere: boolean }) => [a.id, a.eligible, a.controlSource, a.registeredHere])).toEqual([[asset.kit, true, "marketplace_transfer", false]]);
    const relist = await req("buyer", "POST", `/v1/tenants/${B}/market/listings`, { kind: "registered_asset", assetId: asset.kit, pricing: "fixed", priceMinor: 200_000_000, currency: "IRR", title: "Drip kit, resale" });
    expect(relist.statusCode, relist.body).toBe(201);
    expect(relist.json().provenance).toMatchObject({ controlledBy: "Buyer co", controlSource: "marketplace_transfer", registeredBy: "Seller farm" });
    // Withdrawing it puts it back to unlisted; the registrant still cannot touch it.
    expect((await req("buyer", "POST", `/v1/tenants/${B}/market/listings/${relist.json().id}/withdraw`)).json().status).toBe("withdrawn");
    expect((await req("seller", "POST", `/v1/tenants/${S}/market/listings/${relist.json().id}/withdraw`)).statusCode).toBe(404);
  });

  it("holds a fixed-price asset for one buyer; cancellation frees it; a withdrawn listing disappears from the catalogue", async () => {
    const l = (await req("seller", "POST", `/v1/tenants/${S}/market/listings`, { kind: "registered_asset", assetId: asset.ewe, pricing: "fixed", priceMinor: 350_000_000, currency: "IRR", title: "Ewe" })).json();
    expect((await req("buyer", "POST", `/v1/tenants/${B}/market/orders`, { listingId: l.id, offerMinor: 1 })).json().error).toBe("fixed_price");
    const o = (await req("buyer", "POST", `/v1/tenants/${B}/market/orders`, { listingId: l.id })).json();
    expect([o.status, o.totalMinor]).toEqual(["awaiting_payment", 350_000_000]);
    expect((await listingOf(l.id)).status).toBe("reserved");
    expect((await req("other", "POST", `/v1/tenants/${O}/market/orders`, { listingId: l.id })).json().error).toBe("listing_unavailable");
    // The seller cannot withdraw while an order holds it.
    expect((await req("seller", "POST", `/v1/tenants/${S}/market/listings/${l.id}/withdraw`)).json().error).toBe("listing_has_open_orders");
    expect((await act("buyer", B, o.id, { action: "cancel" })).json().status).toBe("cancelled");
    expect((await listingOf(l.id)).status).toBe("active");
    expect((await req("seller", "POST", `/v1/tenants/${S}/market/listings/${l.id}/withdraw`)).json().status).toBe("withdrawn");
    expect((await req("other", "GET", `/v1/tenants/${O}/market/listings/${l.id}`)).statusCode).toBe(404);
    expect((await req("seller", "GET", `/v1/tenants/${S}/market/listings/${l.id}`)).json().status).toBe("withdrawn");
    // The application role cannot write marketplace tables directly (every write is a checked path).
    await expect(
      withSystem(pool, async (tx) => {
        await tx.query("SET LOCAL ROLE metafarm_app");
        await tx.query("SELECT set_config('app.tenant_id', $1, true)", [S]);
        await tx.query(`UPDATE market_listings SET status = 'active' WHERE id = $1`, [l.id]);
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
