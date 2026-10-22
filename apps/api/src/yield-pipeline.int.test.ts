/**
 * Line join, end to end against PostgreSQL: the Y9 workflow with the real yield pipeline as its engine (simulation
 * cycles, fixture ownership). calculate → freeze is stable under retries and versioning: preview changes nothing
 * and repeats exactly; an idempotent retry replays the same answer; a second calculate is refused without change;
 * unlock invalidates (keeps) the set and a recalculation of the same locked records freezes the same set hash under
 * the next set number; a new cycle version gives a new set hash.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { addWallet, advanceOwnershipCursor, createFarm, createParty, createPool, createTenantWithOwner, insertOwnershipEvents, migrateUp, upsertUserBySubject, withSystem, withTenant, type Pool } from "@metafarm/db";
import { base58Encode } from "@metafarm/chain";
import type { ChainAssetRef, OwnershipEvent, Role } from "@metafarm/domain";
import { calculationPolicyHash, canonicalSimulationDossier } from "@metafarm/domain/yield";
import { buildTestApp, tokenFor } from "./test/helpers";
import { POLICY, dossierFor, h } from "./test/yield-dossier";
import { createPipelineYieldEngine } from "./lib/yield-pipeline-engine";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const b58 = (n: number) => base58Encode(randomBytes(n));
const SETTLE = "So11111111111111111111111111111111111111112";

d("yield pipeline engine through the workflow (line join)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const who = (r: Role) => `yp-${r}-${sfx}`;
  let tenantId: string;
  let assetId: string;
  let pa: string;
  let pb: string;
  const chainAsset: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: b58(32) };
  const [wA, wB, stranger] = [b58(32), b58(32), b58(32)];
  let evidence: { e1: string; e2: string };

  const call = async (method: "GET" | "POST" | "PATCH", path: string, as: Role, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url: `/v1/tenants/${tenantId}/yield${path}`, headers: { authorization: `Bearer ${await tokenFor(who(as))}`, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });

  /** A simulation cycle with the scenario's lines, parameters, dossier and slot range, locked. */
  async function preparedCycle(version: number) {
    const id = (await call("POST", "/cycles", "manager", { businessAssetId: assetId, periodStart: "2026-01-01", periodEnd: "2026-03-31", version, network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: chainAsset.id })).json().id as string;
    for (const [side, kind, amount, ev, ref] of [["revenue", "gross_revenue", "800000", evidence.e1, "INV-1"], ["expense", "operating_expense", "300000", evidence.e2, "EXP-1"]] as const)
      expect((await call("POST", `/cycles/${id}/inputs`, "manager", { side, kind, amount, currency: "USD", completeness: "known", evidenceId: ev, sourceKind: "invoice", sourceRef: ref })).statusCode).toBe(201);
    const params = { entitlementRef: POLICY.entitlement.sha256, policyHash: await calculationPolicyHash(POLICY), formulaVersion: "yield-formula/1", accountingCurrency: "USD", settlementMint: SETTLE, settlementDecimals: 6 };
    expect((await call("PATCH", `/cycles/${id}`, "manager", params)).statusCode).toBe(200);
    const dossier = JSON.parse(canonicalSimulationDossier(dossierFor({ [pa]: "01".repeat(32), [pb]: null })));
    const reg = await call("POST", `/cycles/${id}/simulation-dossier`, "manager", dossier);
    expect(reg.statusCode, reg.body).toBe(201);
    expect(reg.json()).toMatchObject({ revision: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await call("POST", `/cycles/${id}/lock`, "manager", { reason: "period ended" })).json().status).toBe("inputs_locked");
    expect((await call("PATCH", `/cycles/${id}`, "manager", { slotStart: "100", slotEnd: "200" })).statusCode).toBe(200);
    return { id, dossier };
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 6 });
    await migrateUp(pool);
    const ids: Record<string, string> = {};
    for (const r of ["owner", "admin", "manager", "verifier"] as const) ids[r] = (await upsertUserBySubject(pool, { issuer: "dev", subject: who(r) })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `yp-${sfx}`, name: "Pipeline", ownerUserId: ids.owner! }));
    for (const r of ["admin", "manager", "verifier"] as const) await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [tenantId, ids[r], r]);
    ({ assetId, pa, pb } = await withTenant(pool, tenantId, async (tx) => {
      const farm = (await createFarm(tx, { name: "Grove", timezone: "UTC", createdBy: ids.owner! })).id;
      const assetId = (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'farm_share', 'Shares') RETURNING id`, [tx.tenantId, farm])).rows[0]!.id;
      const pa = await createParty(tx, { kind: "person", displayName: "A", createdBy: ids.owner! });
      const pb = await createParty(tx, { kind: "organisation", displayName: "B", createdBy: ids.owner! });
      await addWallet(tx, pa, "solana-devnet", wA);
      await addWallet(tx, pb, "solana-devnet", wB);
      return { assetId, pa, pb };
    }));
    const ev = (to: string, amount: bigint, slot: bigint): OwnershipEvent => ({ asset: chainAsset, kind: "mint", from: null, to, amount, slot, txIndex: 0, ixIndex: 0, signature: b58(64) });
    await withSystem(pool, async (tx) => {
      await insertOwnershipEvents(tx, [ev(wA, 600n, 10n), ev(wB, 300n, 11n), ev(stranger, 100n, 12n)], "fixture");
      await advanceOwnershipCursor(tx, chainAsset, 500n, "fixture");
    });
    ({ app } = await buildTestApp({ pool, env: { YIELD_WORKFLOW_ENABLED: "true" }, deps: { yieldEngine: createPipelineYieldEngine() } }));
    const reg = async (n: number) => (await call("POST", "/evidence", "manager", { contentSha256: h(n), evidenceType: "sales_invoice", classification: "confidential" })).json().id as string;
    evidence = { e1: await reg(1), e2: await reg(2) };
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("preview repeats exactly and changes nothing; calculate freezes once; retries replay; a second calculate is refused", async () => {
    const { id, dossier } = await preparedCycle(11);
    expect((await call("POST", `/cycles/${id}/simulation-dossier`, "manager", dossier)).json().error).toBe("cycle_not_draft");

    const p1 = (await call("POST", `/cycles/${id}/preview`, "manager", {})).json();
    const p2 = (await call("POST", `/cycles/${id}/preview`, "manager", {})).json();
    expect(p1.preview).toBe(true);
    expect(p2.hashes).toEqual(p1.hashes);
    expect((await call("GET", `/cycles/${id}`, "manager")).json()).toMatchObject({ status: "inputs_locked", artifactSets: [] });

    const key = "00000000-0000-4000-8000-" + randomBytes(6).toString("hex");
    const c1 = await call("POST", `/cycles/${id}/calculate`, "manager", {}, { "idempotency-key": key });
    expect(c1.statusCode, c1.body).toBe(200);
    const frozen = c1.json();
    expect(frozen).toMatchObject({ status: "calculated", artifactSetHash: p1.hashes.set, merkleRoot: p1.hashes.merkleRoot });
    expect(frozen.artifactSets).toHaveLength(1);
    // An idempotent retry gets the same answer and runs nothing again.
    const replay = await call("POST", `/cycles/${id}/calculate`, "manager", {}, { "idempotency-key": key });
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json()).toEqual(frozen);
    // A new calculate is refused without change; so is preview of a calculated cycle.
    expect((await call("POST", `/cycles/${id}/calculate`, "manager", {})).json().error).toBe("invalid_transition");
    expect((await call("POST", `/cycles/${id}/preview`, "manager", {})).json().error).toBe("invalid_transition");
    const after = (await call("GET", `/cycles/${id}`, "manager")).json();
    expect([after.artifactSetHash, after.artifactSets.length]).toEqual([frozen.artifactSetHash, 1]);
    expect((await call("GET", `/cycles/${id}/reconciliation`, "manager")).json()).toMatchObject({ consistent: true, findings: [] });

    // The stored rows are the pipeline's: allocated, withheld, unattributed, in the 6 : 3 : 1 weights.
    const rows = (await call("GET", `/cycles/${id}/artifact-sets/${frozen.artifactSetId}/allocations`, "manager")).json().items as { kind: string; partyId: string | null; weight: string; amount: string }[];
    expect(rows.map((r) => [r.kind, r.partyId, r.weight]).sort()).toEqual(
      [
        ["allocated", pa, "60000"],
        ["unattributed", null, "10000"],
        ["withheld", pb, "30000"],
      ].sort(),
    );
  });

  it("unlock keeps the frozen set (invalidated); the same locked records freeze the same set hash under the next set number", async () => {
    const { id } = await preparedCycle(12);
    const first = (await call("POST", `/cycles/${id}/calculate`, "manager", {})).json();
    expect((await call("POST", `/cycles/${id}/unlock`, "manager", { reason: "re-check" })).json()).toMatchObject({ status: "inputs_locked", artifactSetHash: null });
    const second = (await call("POST", `/cycles/${id}/calculate`, "manager", {})).json();
    expect(second.artifactSetHash).toBe(first.artifactSetHash);
    expect(second.artifactSets.map((s: { setNumber: number; status: string }) => [s.setNumber, s.status])).toEqual([
      [1, "invalidated"],
      [2, "frozen"],
    ]);
    // Through review to publication with four-eyes and an attestation of the frozen hash.
    await call("POST", `/cycles/${id}/submit`, "manager", {});
    expect((await call("POST", `/cycles/${id}/attestations`, "verifier", { artifactSetId: second.artifactSetId, attestedHash: second.artifactSetHash, statement: "re-computed" })).statusCode).toBe(201);
    expect((await call("POST", `/cycles/${id}/approve`, "manager", {})).statusCode).toBe(403);
    expect((await call("POST", `/cycles/${id}/approve`, "admin", {})).json().status).toBe("approved");
    expect((await call("POST", `/cycles/${id}/publish`, "admin", {})).json().status).toBe("published");
    expect((await call("GET", `/cycles/${id}/reconciliation`, "admin")).json()).toMatchObject({ consistent: true });
  });

  it("a new cycle version freezes a different set hash (versions never collide)", async () => {
    const a = (await call("POST", `/cycles/${(await preparedCycle(13)).id}/calculate`, "manager", {})).json();
    const b = (await call("POST", `/cycles/${(await preparedCycle(14)).id}/calculate`, "manager", {})).json();
    expect(b.artifactSetHash).not.toBe(a.artifactSetHash);
  });

  it("refuses to calculate without a dossier, and stores nothing", async () => {
    const id = (await call("POST", "/cycles", "manager", { businessAssetId: assetId, periodStart: "2026-04-01", periodEnd: "2026-06-30", network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: chainAsset.id })).json().id as string;
    await call("PATCH", `/cycles/${id}`, "manager", { entitlementRef: POLICY.entitlement.sha256, policyHash: await calculationPolicyHash(POLICY), formulaVersion: "yield-formula/1", accountingCurrency: "USD", settlementMint: SETTLE, settlementDecimals: 6 });
    await call("POST", `/cycles/${id}/lock`, "manager", {});
    await call("PATCH", `/cycles/${id}`, "manager", { slotStart: "100", slotEnd: "200" });
    const r = await call("POST", `/cycles/${id}/calculate`, "manager", {});
    expect([r.statusCode, r.json().error]).toEqual([422, "dossier_missing"]);
    expect((await call("GET", `/cycles/${id}`, "manager")).json()).toMatchObject({ status: "inputs_locked", artifactSets: [] });
  });
});
