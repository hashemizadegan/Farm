/**
 * Y9: the preparer and reviewer workflow for simulation cycles against a real database, with a deterministic stub
 * engine (the real calculation library lives on the yield line). Off by default; real cycles refused; preview stores
 * nothing; calculate freezes (D-11); four-eyes and the simulation quorum; engine output checked against ownership.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  addWallet,
  advanceOwnershipCursor,
  createFarm,
  createParty,
  createPool,
  createTenantWithOwner,
  insertOwnershipEvents,
  migrateUp,
  upsertUserBySubject,
  withSystem,
  withTenant,
  type Pool,
} from "@metafarm/db";
import { base58Encode } from "@metafarm/chain";
import type { ChainAssetRef, OwnershipEvent, Role } from "@metafarm/domain";
import { buildTestApp, tokenFor } from "./test/helpers";
import { stubYieldEngine } from "./test/yield-stub-engine";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const b58 = (n: number) => base58Encode(randomBytes(n));
const h = (c: string) => c.repeat(64);
const MINT = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";

d("yield workflow (Y9)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let noEngine: FastifyInstance;
  let off: FastifyInstance;
  const engine = stubYieldEngine();
  const sfx = Math.random().toString(36).slice(2, 8);
  const who = (r: Role) => `yw-${r}-${sfx}`;
  let tenantId: string;
  let assetId: string;
  let partyA: string;
  let partyB: string;
  const chainAsset: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: b58(32) };
  const [wA, wB, stranger] = [b58(32), b58(32), b58(32)];

  const call = async (method: "GET" | "POST" | "PATCH", path: string, as: Role, payload?: unknown, on = app) =>
    on.inject({ method, url: `/v1/tenants/${tenantId}/yield${path}`, headers: { authorization: `Bearer ${await tokenFor(who(as))}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  let versions = 1;
  const newCycle = async (as: Role = "manager") => {
    const r = await call("POST", "/cycles", as, { businessAssetId: assetId, periodStart: "2026-01-01", periodEnd: "2026-03-31", version: ++versions, network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: chainAsset.id });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  /** A simulation cycle with one revenue line, locked, with its slot range. */
  const lockedCycle = async (as: Role = "manager") => {
    const id = await newCycle(as);
    const ev = (await call("POST", "/evidence", as, { contentSha256: randomBytes(32).toString("hex"), evidenceType: "invoice", classification: "internal" })).json().id;
    expect((await call("POST", `/cycles/${id}/inputs`, as, { side: "revenue", kind: "sale", amount: "1000", currency: "EUR", completeness: "known", evidenceId: ev, sourceKind: "invoice", sourceRef: `INV-${id}` })).statusCode).toBe(201);
    expect((await call("POST", `/cycles/${id}/inputs`, as, { side: "expense", kind: "fuel", amount: "1", currency: "EUR", completeness: "known", sourceKind: "invoice", sourceRef: `EXP-${id}` })).statusCode).toBe(201);
    expect((await call("PATCH", `/cycles/${id}`, as, { entitlementRef: h("a"), policyHash: h("b"), formulaVersion: "stub/1", accountingCurrency: "EUR", settlementMint: MINT, settlementDecimals: 6 })).statusCode).toBe(200);
    expect((await call("POST", `/cycles/${id}/lock`, as, { reason: "period ended" })).json().status).toBe("inputs_locked");
    expect((await call("PATCH", `/cycles/${id}`, as, { slotStart: "100", slotEnd: "200" })).statusCode).toBe(200);
    return id;
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 6 });
    await migrateUp(pool);
    const ids: Record<string, string> = {};
    for (const r of ["owner", "admin", "manager", "verifier", "viewer"] as const) ids[r] = (await upsertUserBySubject(pool, { issuer: "dev", subject: who(r) })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `yw-${sfx}`, name: "Workflow", ownerUserId: ids.owner! }));
    for (const r of ["admin", "manager", "verifier", "viewer"] as const) await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [tenantId, ids[r], r]);
    ({ assetId, partyA, partyB } = await withTenant(pool, tenantId, async (tx) => {
      const farm = (await createFarm(tx, { name: "Grove", timezone: "UTC", createdBy: ids.owner! })).id;
      const assetId = (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'farm_share', 'Shares') RETURNING id`, [tx.tenantId, farm])).rows[0]!.id;
      const partyA = await createParty(tx, { kind: "person", displayName: "A", createdBy: ids.owner! });
      const partyB = await createParty(tx, { kind: "organisation", displayName: "B", createdBy: ids.owner! });
      await addWallet(tx, partyA, "solana-devnet", wA);
      await addWallet(tx, partyB, "solana-devnet", wB);
      return { assetId, partyA, partyB };
    }));
    // Simulation ownership (fixture source): A 600, B 300, an unregistered wallet 100, all before the window.
    const ev = (to: string, amount: bigint, slot: bigint): OwnershipEvent => ({ asset: chainAsset, kind: "mint", from: null, to, amount, slot, txIndex: 0, ixIndex: 0, signature: b58(64) });
    await withSystem(pool, async (tx) => {
      await insertOwnershipEvents(tx, [ev(wA, 600n, 10n), ev(wB, 300n, 11n), ev(stranger, 100n, 12n)], "fixture");
      await advanceOwnershipCursor(tx, chainAsset, 500n, "fixture");
    });
    ({ app } = await buildTestApp({ pool, env: { YIELD_WORKFLOW_ENABLED: "true" }, deps: { yieldEngine: engine } }));
    ({ app: noEngine } = await buildTestApp({ pool, env: { YIELD_WORKFLOW_ENABLED: "true" } }));
    ({ app: off } = await buildTestApp({ pool }));
  });
  afterAll(async () => {
    await Promise.all([app?.close(), noEngine?.close(), off?.close()]);
    await pool?.end();
  });

  it("is off by default (404) and creates simulation cycles only", async () => {
    expect((await call("POST", "/cycles", "manager", { businessAssetId: assetId }, off)).statusCode).toBe(404);
    const real = await call("POST", "/cycles", "manager", { businessAssetId: assetId, periodStart: "2026-01-01", periodEnd: "2026-03-31", simulation: false, network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: chainAsset.id });
    expect([real.statusCode, real.json().error]).toEqual([409, "real_gate"]);
    expect((await call("POST", "/cycles", "viewer", { businessAssetId: assetId, periodStart: "2026-01-01", periodEnd: "2026-03-31", network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: chainAsset.id })).statusCode).toBe(403);
    expect((await call("POST", "/cycles", "verifier", { businessAssetId: assetId, periodStart: "2026-01-01", periodEnd: "2026-03-31", network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: chainAsset.id })).statusCode).toBe(403);
  });

  it("runs lock → preview → calculate → attest → approve → publish → close, with four-eyes and the quorum", async () => {
    const id = await lockedCycle("manager");
    const before = engine.calls;
    const p = await call("POST", `/cycles/${id}/preview`, "manager", {});
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toMatchObject({ preview: true, ownership: { sourceKind: "fixture", totalWeight: "100000" }, totals: { net: "999" } });
    expect(p.json().allocations).toEqual([
      ...[
        { kind: "allocated", partyId: partyA, holderKey: null, weight: "60000", amount: "599" },
        { kind: "allocated", partyId: partyB, holderKey: null, weight: "30000", amount: "299" },
      ].sort((x, y) => (x.partyId < y.partyId ? -1 : 1)),
      { kind: "unattributed", partyId: null, holderKey: stranger, weight: "10000", amount: "99" },
      { kind: "dust", partyId: null, holderKey: null, weight: "0", amount: "2" },
    ]);
    // Preview changes nothing.
    const still = (await call("GET", `/cycles/${id}`, "manager")).json();
    expect([still.status, still.artifactSets]).toEqual(["inputs_locked", []]);
    expect(engine.calls).toBe(before + 1);

    const c = await call("POST", `/cycles/${id}/calculate`, "manager", {});
    expect(c.statusCode, c.body).toBe(200);
    const calc = c.json();
    expect([calc.status, calc.artifactSets[0].status, calc.artifactSets[0].ownershipSnapshot.sourceKind]).toEqual(["calculated", "frozen", "fixture"]);
    expect(calc.artifactSetHash).toBe(calc.artifactSets[0].hashes.set);
    // Frozen at calculate (D-11): parameters and inputs can no longer change.
    expect((await call("PATCH", `/cycles/${id}`, "manager", { slotEnd: "250" })).json().error).toBe("frozen");
    expect((await call("POST", `/cycles/${id}/submit`, "manager", {})).json().status).toBe("under_review");

    expect((await call("POST", `/cycles/${id}/approve`, "admin", {})).json().error).toBe("quorum_not_met");
    expect((await call("POST", `/cycles/${id}/attestations`, "manager", { artifactSetId: calc.artifactSetId, attestedHash: calc.artifactSetHash, statement: "ok" })).statusCode).toBe(403);
    const bad = await call("POST", `/cycles/${id}/attestations`, "verifier", { artifactSetId: calc.artifactSetId, attestedHash: h("0"), statement: "ok" });
    expect([bad.statusCode, bad.json().error]).toEqual([422, "attestation_mismatch"]);
    expect((await call("POST", `/cycles/${id}/attestations`, "verifier", { artifactSetId: calc.artifactSetId, attestedHash: calc.artifactSetHash, statement: "checked against inputs" })).statusCode).toBe(201);
    expect((await call("POST", `/cycles/${id}/approve`, "verifier", {})).statusCode).toBe(403);
    expect((await call("POST", `/cycles/${id}/approve`, "admin", { reason: "reviewed" })).json().status).toBe("approved");
    expect((await call("POST", `/cycles/${id}/publish`, "admin", {})).json().status).toBe("published");
    const closed = await call("POST", `/cycles/${id}/close`, "admin", { reason: "simulation" });
    expect([closed.json().status, closed.json().closeReason]).toEqual(["closed", "simulation"]);
    const t = (await call("GET", `/cycles/${id}/transitions`, "verifier")).json().items.map((x: { command: string }) => x.command);
    expect(t).toEqual(["create", "lock", "calculate", "submit", "approve", "publish", "close"]);
  });

  it("refuses an approval by the cycle's creator or preparer (four-eyes), whatever the role", async () => {
    const id = await lockedCycle("owner");
    const calc = (await call("POST", `/cycles/${id}/calculate`, "owner", {})).json();
    await call("POST", `/cycles/${id}/submit`, "owner", {});
    await call("POST", `/cycles/${id}/attestations`, "verifier", { artifactSetId: calc.artifactSetId, attestedHash: calc.artifactSetHash, statement: "ok" });
    const r = await call("POST", `/cycles/${id}/approve`, "owner", {});
    expect([r.statusCode, r.json().error]).toEqual([403, "four_eyes"]);
    // A reviewer's rejection needs a reason, returns to inputs_locked and invalidates the set (kept).
    expect((await call("POST", `/cycles/${id}/reject`, "verifier", {})).statusCode).toBe(400);
    expect((await call("POST", `/cycles/${id}/reject`, "verifier", { reason: "wrong slot range" })).json().status).toBe("inputs_locked");
    expect((await call("GET", `/cycles/${id}`, "verifier")).json().artifactSets.map((s: { status: string }) => s.status)).toEqual(["invalidated"]);
  });

  it("fails closed without an engine, on an engine that invents a recipient, and on unindexed ownership; nothing is stored", async () => {
    const id = await lockedCycle();
    for (const op of ["preview", "calculate"]) {
      const r = await call("POST", `/cycles/${id}/${op}`, "manager", {}, noEngine);
      expect([r.statusCode, r.json().error]).toEqual([503, "calculation_engine_unavailable"]);
    }
    const { app: liar } = await buildTestApp({ pool, env: { YIELD_WORKFLOW_ENABLED: "true" }, deps: { yieldEngine: stubYieldEngine((o) => ({ ...o, allocations: [...o.allocations, { kind: "unattributed", holderKey: b58(32), weight: 1n, amount: 1n }] })) } });
    try {
      const r = await call("POST", `/cycles/${id}/calculate`, "manager", {}, liar);
      expect([r.statusCode, r.json().error]).toEqual([502, "engine_output_invalid"]);
    } finally {
      await liar.close();
    }
    expect((await call("GET", `/cycles/${id}`, "manager")).json()).toMatchObject({ status: "inputs_locked", artifactSets: [] });
    // A cycle whose window ends after the index cursor (500) is incomplete history.
    const late = await newCycle();
    await call("PATCH", `/cycles/${late}`, "manager", { entitlementRef: h("a"), policyHash: h("b"), formulaVersion: "stub/1", accountingCurrency: "EUR", settlementMint: MINT, settlementDecimals: 6 });
    await call("POST", `/cycles/${late}/lock`, "manager", {});
    await call("PATCH", `/cycles/${late}`, "manager", { slotStart: "100", slotEnd: "900" });
    const r = await call("POST", `/cycles/${late}/calculate`, "manager", {});
    expect([r.statusCode, r.json().error]).toEqual([409, "incomplete_history"]);
  });

  it("cancels before publication with a reason, and refuses inputs once locked", async () => {
    const id = await lockedCycle();
    const r = await call("POST", `/cycles/${id}/inputs`, "manager", { side: "revenue", kind: "sale", amount: "5", currency: "EUR", completeness: "known", sourceKind: "invoice", sourceRef: "late" });
    expect([r.statusCode, r.json().error]).toEqual([409, "cycle_not_draft"]);
    expect((await call("POST", `/cycles/${id}/cancel`, "manager", { reason: "x" })).statusCode).toBe(403);
    expect((await call("POST", `/cycles/${id}/cancel`, "admin", { reason: "duplicate cycle" })).json().status).toBe("cancelled");
    expect((await call("POST", `/cycles/${id}/unlock`, "manager", {})).json().error).toBe("invalid_transition");
  });
});
