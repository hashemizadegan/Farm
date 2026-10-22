/**
 * Y8: the yield operator read API against a real database. Authorization per role (D-28), paging, the audit trail
 * behind audit:read, tenant isolation, and the public summary route not registered (D-30).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createFarm,
  createParty,
  createPool,
  createTenantWithOwner,
  createYieldCycle,
  migrateUp,
  recordCalculation,
  setYieldCycleParameters,
  transitionYieldCycle,
  upsertUserBySubject,
  withSystem,
  withTenant,
  type Pool,
} from "@metafarm/db";
import type { Role } from "@metafarm/domain";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const MINT = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const h = (c: string) => c.repeat(64);

d("yield operator read API (Y8)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const who = (r: Role | "outsider") => `yr-${r}-${sfx}`;
  let tenantId: string;
  let cycleId: string;
  let setId: string;
  let ownerId: string;

  const get = async (path: string, as: Role | "outsider" = "owner", tenant = tenantId) =>
    app.inject({ method: "GET", url: `/v1/tenants/${tenant}/yield${path}`, headers: { authorization: `Bearer ${await tokenFor(who(as))}` } });

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    const ids: Record<string, string> = {};
    for (const r of ["owner", "admin", "manager", "verifier", "worker", "viewer", "outsider"] as const) ids[r] = (await upsertUserBySubject(pool, { issuer: "dev", subject: who(r) })).id;
    ownerId = ids.owner!;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `yr-${sfx}`, name: "Yield read", ownerUserId: ownerId }));
    await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `yr-o-${sfx}`, name: "Outsider", ownerUserId: ids.outsider! }));
    for (const r of ["admin", "manager", "verifier", "worker", "viewer"] as const) await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [tenantId, ids[r], r]);
    const manager = ids.manager!;
    ({ cycleId, setId } = await withTenant(pool, tenantId, async (tx) => {
      const farm = (await createFarm(tx, { name: "Grove", timezone: "UTC", createdBy: ownerId })).id;
      const asset = (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'farm_share', 'Shares') RETURNING id`, [tx.tenantId, farm])).rows[0]!.id;
      const party = await createParty(tx, { kind: "person", displayName: "Holder", createdBy: ownerId });
      for (const v of [1, 2, 3]) await createYieldCycle(tx, { businessAssetId: asset, periodStart: "2026-01-01", periodEnd: "2026-03-31", version: v + 10, network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: MINT, createdBy: manager });
      const c = await createYieldCycle(tx, { businessAssetId: asset, periodStart: "2026-01-01", periodEnd: "2026-03-31", network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: MINT, createdBy: manager });
      await setYieldCycleParameters(tx, c.id, { entitlementRef: h("a"), policyHash: h("b"), formulaVersion: "f1", accountingCurrency: "EUR", settlementMint: MINT, settlementDecimals: 6 }, manager);
      await transitionYieldCycle(tx, c.id, { to: "inputs_locked", actorUserId: manager, reason: "period ended" });
      await setYieldCycleParameters(tx, c.id, { slotStart: 100n, slotEnd: 200n }, manager);
      const r = await recordCalculation(tx, c.id, {
        calculationHash: h("1"), allocationHash: h("2"), evidenceBundleHash: h("3"), merkleRoot: h("4"), setHash: h("5"),
        snapshot: { sourceKind: "fixture", sourceIdentityId: null, cursorSlot: 300n, holdingModel: "slot_weighted", inputCommitment: h("6"), totalWeight: 100n },
        allocations: [{ kind: "allocated", partyId: party, weight: 100n, amount: 1000n }],
        actorUserId: manager,
      });
      return { cycleId: c.id, setId: r.artifactSetId };
    }));
    ({ app } = await buildTestApp({ pool }));
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("serves cycles to roles holding yield:read and refuses the others (D-28)", async () => {
    for (const r of ["owner", "admin", "manager", "verifier"] as const) expect((await get("/cycles", r)).statusCode, r).toBe(200);
    for (const r of ["worker", "viewer"] as const) expect((await get("/cycles", r)).statusCode, r).toBe(403);
    expect((await get("/cycles", "outsider")).statusCode).toBe(404);
  });

  it("pages cycles newest first, filters, and refuses a foreign cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await get(`/cycles?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.statusCode).toBe(200);
      const body = r.json() as { items: { id: string; simulation: boolean }[]; nextCursor: string | null };
      expect(body.items.every((c) => c.simulation)).toBe(true);
      seen.push(...body.items.map((c) => c.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    // All four were created in one transaction (same created_at): the id breaks the tie, so the order is fixed
    // but not the insertion order.
    expect(seen).toContain(cycleId);
    expect((await get("/cycles?status=calculated")).json().items.map((c: { id: string }) => c.id)).toEqual([cycleId]);
    expect((await get(`/cycles?cursor=${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`)).statusCode).toBe(400);
    expect((await get("/cycles?status=bogus")).statusCode).toBe(400);
  });

  it("returns a cycle with its artifact set, snapshot provenance and history", async () => {
    const r = await get(`/cycles/${cycleId}`, "verifier");
    expect(r.statusCode).toBe(200);
    const c = r.json();
    expect([c.status, c.simulation, c.slotRange, c.artifactSetHash]).toEqual(["calculated", true, { start: "100", end: "200" }, h("5")]);
    expect(c.artifactSets).toHaveLength(1);
    expect(c.artifactSets[0]).toMatchObject({ id: setId, setNumber: 1, status: "frozen", attesters: 0, ownershipSnapshot: { sourceKind: "fixture", sourceIdentityId: null, totalWeight: "100", holdingModel: "slot_weighted" } });
    const t = (await get(`/cycles/${cycleId}/transitions`)).json().items.map((x: { command: string }) => x.command);
    expect(t).toEqual(["create", "lock", "calculate"]);
    const a = (await get(`/cycles/${cycleId}/artifact-sets/${setId}/allocations`, "manager")).json().items;
    expect(a).toEqual([expect.objectContaining({ kind: "allocated", weight: "100", amount: "1000" })]);
    expect((await get(`/cycles/${cycleId}/artifact-sets/${cycleId}/allocations`)).statusCode).toBe(404);
  });

  it("keeps the audit trail behind audit:read", async () => {
    expect((await get(`/cycles/${cycleId}/audit`, "manager")).statusCode).toBe(403);
    expect((await get(`/cycles/${cycleId}/audit`, "verifier")).statusCode).toBe(403);
    const r = await get(`/cycles/${cycleId}/audit`, "admin");
    expect(r.statusCode).toBe(200);
    expect(r.json().items.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["yield.cycle.create", "yield.cycle.lock", "yield.cycle.calculate"]));
  });

  it("does not show another tenant's cycle, and has no public route; the workflow is off by default", async () => {
    const otherTenant = (await pool.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = $1`, [`yr-o-${sfx}`])).rows[0]!.id;
    const r = await app.inject({ method: "GET", url: `/v1/tenants/${otherTenant}/yield/cycles/${cycleId}`, headers: { authorization: `Bearer ${await tokenFor(who("outsider"))}` } });
    expect(r.statusCode).toBe(404);
    expect(app.hasRoute({ method: "GET", url: "/v1/public/yield/cycles/:cycleId" })).toBe(false);
    const w = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/yield/cycles/${cycleId}/lock`, headers: { authorization: `Bearer ${await tokenFor(who("owner"))}` }, payload: {} });
    expect(w.statusCode).toBe(404);
  });
});
