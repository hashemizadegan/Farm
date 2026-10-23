/**
 * Preview and local seed for the marketplace journey (simulation only; every name labelled "(simulation)").
 *
 * Two separate users in two workspaces (from `pnpm db:seed`):
 * - seller: `dev-user`, owner of "Demo Tenant": a farm, harvest batches and registered assets, some listed;
 * - buyer: `dev-other`, owner of "Other Tenant": nothing listed; buys and makes offers.
 *
 * Demo Tenant gets "Pistachio grove (simulation)" with:
 * - produce (harvest batches, through the harvest route): pistachios (80 of 120 kg listed, three delivery methods),
 *   saffron (0.25 of 0.5 kg listed, courier only), pomegranates (eligible, not listed), walnuts (voided: not eligible);
 * - registered assets (verified by a second demo member, four eyes): a ewe (fixed price), a drip irrigation kit
 *   (offers), a 1% grove share (eligible, not listed) and a ram still in draft (not eligible).
 * Listings are created through POST /market/listings, so the eligibility rules apply. One small saffron order is taken
 * all the way to "delivered" (paid, prepared, dispatched with a manual courier reference, receipt confirmed) so the
 * history and audit trail are not empty; everything else is left for the reviewer to do in the browser.
 *
 * Refused unless APP_ENV is development or test. Needs MARKETPLACE_ENABLED. Idempotent: a second run reports the
 * existing farm and changes nothing. Usage: pnpm seed:marketplace (or step 4 of the preview seed runner).
 */
import { apiEnvSchema } from "@metafarm/config";
import { createPool, upsertUserBySubject, withSystem } from "@metafarm/db";
import { createLogger } from "@metafarm/observability";
import { createMemoryStorage } from "@metafarm/storage";
import { buildApp } from "../app";
import { createDevProvider, mintDevToken } from "../auth/dev";
import { createMemoryProducer } from "../queue/producer";

export const MARKET_FARM = "Pistachio grove (simulation)";
export const MARKET_ITEMS = {
  pistachios: "Pistachios, Akbari (simulation)",
  saffron: "Saffron, Sargol (simulation)",
  pomegranates: "Pomegranates (simulation)",
  walnuts: "Walnuts (simulation)",
  ewe: "Ewe A-12 (simulation)",
  drip: "Drip irrigation kit, block 2 (simulation)",
  share: "Pistachio grove 1% share (simulation)",
  ram: "Ram B-03 (simulation)",
} as const;

const log = (m: string) => console.log(`[seed:marketplace] ${m}`);
const fail = (m: string): never => {
  console.error(`[seed:marketplace] refused: ${m}`);
  process.exit(1);
};

if (process.env.APP_ENV !== "development" && process.env.APP_ENV !== "test") fail("APP_ENV must be development or test (simulation data for a local or isolated preview database)");
const secret = process.env.DEV_AUTH_SECRET ?? fail("DEV_AUTH_SECRET must be set (the seed signs in as dev-user and dev-other)");
const env = apiEnvSchema.parse(process.env);
if (!env.MARKETPLACE_ENABLED) {
  log("MARKETPLACE_ENABLED is not set: skipped (set it on api and seed-runner to seed the marketplace)");
  process.exit(0);
}
const pool = createPool({ connectionString: env.DATABASE_URL, max: 4 });

async function main() {
  const tenants = (await pool.query<{ id: string; slug: string }>(`SELECT id, slug FROM tenants WHERE slug IN ('demo', 'other')`)).rows;
  const seller = tenants.find((t) => t.slug === "demo")?.id;
  const buyer = tenants.find((t) => t.slug === "other")?.id;
  if (!seller || !buyer) throw new Error("the demo and other workspaces are missing: run `pnpm db:seed` (or the preview seed runner) first");
  const existing = (await pool.query<{ id: string }>(`SELECT id FROM farms WHERE tenant_id = $1 AND name = $2`, [seller, MARKET_FARM])).rows[0];
  if (existing) {
    log(`already seeded: ${MARKET_FARM} (${existing.id})`);
    return;
  }

  const app = await buildApp({
    deps: { env, logger: createLogger({ service: "seed-marketplace", level: "warn" }), pool, jobs: createMemoryProducer(), storage: createMemoryStorage(), auth: createDevProvider(secret), now: () => new Date() },
    docs: false,
  });
  const asSeller = `Bearer ${await mintDevToken(secret, "dev-user", "dev-user")}`;
  const asBuyer = `Bearer ${await mintDevToken(secret, "dev-other", "dev-other")}`;
  const call = async <T = Record<string, unknown>>(auth: string, method: "GET" | "POST", url: string, payload?: unknown): Promise<T> => {
    const r = await app.inject({ method, url, headers: { authorization: auth }, ...(payload === undefined ? {} : { payload: payload as object }) });
    if (r.statusCode >= 300) throw new Error(`${method} ${url.replace(/[0-9a-f-]{36}/g, "…")} → ${r.statusCode} ${r.json().error ?? ""} ${r.json().message ?? ""}`);
    return r.json() as T;
  };
  const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

  try {
    const s = `/v1/tenants/${seller}`;
    const farm = await call<{ id: string }>(asSeller, "POST", `${s}/farms`, { name: MARKET_FARM, description: "Simulation data for the marketplace walkthrough; not a real farm." });

    // ── Produce: harvest batches through the harvest route (immutable, traceable records). ──
    const batch = (cropName: string, quantity: string, unit: string, qualityGrade: string | null, daysAgo: number) =>
      call<{ id: string; code: string }>(asSeller, "POST", `${s}/farms/${farm.id}/harvests`, { cropName, quantity, unit, qualityGrade, harvestedOn: day(daysAgo), parcelLabel: "Block 2 (simulation)" });
    const pistachios = await batch(MARKET_ITEMS.pistachios, "120", "kg", "Grade A (simulation)", 12);
    const saffron = await batch(MARKET_ITEMS.saffron, "0.5", "kg", "Category I (simulation)", 20);
    await batch(MARKET_ITEMS.pomegranates, "300", "kg", null, 6);
    const walnuts = await batch(MARKET_ITEMS.walnuts, "50", "kg", null, 9);
    await call(asSeller, "POST", `${s}/farms/${farm.id}/harvests/${walnuts.id}/void`, { reason: "Recorded twice (simulation)" });

    // ── Registered assets: registered by dev-user, verified by a second demo member (four eyes). ──
    const verifier = await upsertUserBySubject(pool, { issuer: "dev", subject: "dev-asset-verifier", name: "Asset verifier (simulation)" });
    const ids = await withSystem(pool, async (tx) => {
      await tx.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'verifier') ON CONFLICT DO NOTHING`, [seller, verifier.id]);
      const owner = (await tx.query<{ id: string }>(`SELECT id FROM users WHERE oidc_issuer = 'dev' AND oidc_subject = 'dev-user'`)).rows[0]!.id;
      const asset = async (kind: string, name: string, ref: string, verified: boolean) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO business_assets (tenant_id, farm_id, kind, name, external_ref, status, verified_by, verified_at, created_by, attributes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{"simulation": true}'::jsonb) RETURNING id`,
            [seller, farm.id, kind, name, ref, verified ? "verified" : "draft", verified ? verifier.id : null, verified ? new Date() : null, owner],
          )
        ).rows[0]!.id;
      return {
        ewe: await asset("livestock", MARKET_ITEMS.ewe, "SIM-EWE-A12", true),
        drip: await asset("equipment", MARKET_ITEMS.drip, "SIM-DRIP-02", true),
        share: await asset("farm_share", MARKET_ITEMS.share, "SIM-SHARE-01", true),
        ram: await asset("livestock", MARKET_ITEMS.ram, "SIM-RAM-B03", false),
      };
    });

    // ── Listings, through the marketplace route (eligibility applies). Prices in rials (simulation). ──
    const list = (body: unknown) => call<{ id: string }>(asSeller, "POST", `${s}/market/listings`, body);
    await list({
      kind: "produce",
      harvestBatchId: pistachios.id,
      quantity: 80,
      priceMinor: 4_500_000,
      currency: "IRR",
      title: "Fresh pistachios, Akbari, Grade A (simulation)",
      description: "Hand-picked and sun-dried in block 2. Per kilogram. Simulation listing: nothing is paid or shipped.",
      deliveryOptions: [
        { method: "pickup", feeMinor: 0, perUnitMinor: 0 },
        { method: "local_delivery", feeMinor: 1_500_000, perUnitMinor: 0 },
        { method: "courier_manual", feeMinor: 2_500_000, perUnitMinor: 50_000 },
      ],
    });
    const saffronListing = await list({
      kind: "produce",
      harvestBatchId: saffron.id,
      quantity: 0.25,
      priceMinor: 600_000_000,
      currency: "IRR",
      title: "Saffron, Sargol, Category I (simulation)",
      description: "Per kilogram; sold in grams. Simulation listing: nothing is paid or shipped.",
      deliveryOptions: [{ method: "courier_manual", feeMinor: 3_000_000, perUnitMinor: 0 }],
    });
    await list({ kind: "registered_asset", assetId: ids.ewe, pricing: "fixed", priceMinor: 350_000_000, currency: "IRR", title: "Ewe A-12, registered (simulation)", description: "Verified livestock record. A sale records a transfer of control on the platform only." });
    await list({ kind: "registered_asset", assetId: ids.drip, pricing: "offers", priceMinor: 180_000_000, currency: "IRR", title: "Drip irrigation kit, block 2 (simulation)", description: "Verified equipment record; offers welcome. A sale records a transfer of control on the platform only." });

    // ── One completed produce order, so the history and the audit trail have an example. ──
    const b = `/v1/tenants/${buyer}`;
    const order = await call<{ id: string }>(asBuyer, "POST", `${b}/market/orders`, {
      listingId: saffronListing.id,
      quantity: 0.01,
      delivery: { method: "courier_manual", address: { recipient: "Other Tenant User (simulation)", line1: "1 Example Street (simulation)", city: "Isfahan", postalCode: "81000", country: "IR", phone: "+98 31 0000 0000" } },
      note: "Seeded example order (simulation)",
    });
    const act = (auth: string, tenant: string, body: unknown) => call(auth, "POST", `/v1/tenants/${tenant}/market/orders/${order.id}/actions`, body);
    await act(asBuyer, buyer, { action: "pay" });
    await act(asSeller, seller, { action: "prepare" });
    await act(asSeller, seller, { action: "dispatch", carrier: "Manual courier (simulation)", trackingRef: "SIM-0001" });
    await act(asBuyer, buyer, { action: "confirm_receipt" });

    const listed = (await call<{ items: { title: string; status: string }[] }>(asSeller, "GET", `${s}/market/listings?scope=mine`)).items;
    log(`${MARKET_FARM} (${farm.id}): ${listed.length} listings (${listed.map((l) => `${l.title}: ${l.status}`).join("; ")}); 1 example order delivered (simulated)`);
  } finally {
    await app.close();
  }
}

main()
  .catch((err) => {
    console.error(`[seed:marketplace] failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
