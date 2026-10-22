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
import {
  addWallet,
  advanceOwnershipCursor,
  authorisePartyLink,
  consentPartyLink,
  createFarm,
  createParty,
  createPool,
  createTenantWithOwner,
  insertOwnershipEvents,
  migrateUp,
  proposePartyLink,
  upsertUserBySubject,
  withSystem,
  withTenant,
  type Pool,
} from "@metafarm/db";
import { base58Encode } from "@metafarm/chain";
import type { ChainAssetRef, OwnershipEvent, Role } from "@metafarm/domain";
import { SHA256_RFC9162_HASHER, calculationPolicyHash, canonicalSimulationDossier, verifyClaimLeafProof } from "@metafarm/domain/yield";
import { buildTestApp, tokenFor } from "./test/helpers";
import { POLICY, dossierFor, h } from "./test/yield-dossier";
import { createPipelineYieldEngine } from "./lib/yield-pipeline-engine";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const b58 = (n: number) => base58Encode(randomBytes(n));
const SETTLE = "So11111111111111111111111111111111111111112";
const unhex = (x: string) => Uint8Array.from(x.match(/../g)!.map((b) => parseInt(b, 16)));

d("yield pipeline engine through the workflow (line join)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const who = (r: Role | "holder" | "holder2") => `yp-${r}-${sfx}`;
  let tenantId: string;
  let assetId: string;
  let secondAssetId: string;
  let pa: string;
  let pb: string;
  const chainAsset: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: b58(32) };
  const [wA, wB, stranger] = [b58(32), b58(32), b58(32)];
  let evidence: { e1: string; e2: string };

  const call = async (method: "GET" | "POST" | "PATCH", path: string, as: Role | "holder" | "holder2", payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url: `/v1/tenants/${tenantId}/yield${path}`, headers: { authorization: `Bearer ${await tokenFor(who(as))}`, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });

  /** A simulation cycle with the scenario's lines, parameters, dossier and slot range, locked. */
  async function preparedCycle(version: number, o: { businessAssetId?: string; period?: [string, string]; dustThreshold?: bigint } = {}) {
    const [periodStart, periodEnd] = o.period ?? ["2026-01-01", "2026-03-31"];
    const id = (await call("POST", "/cycles", "manager", { businessAssetId: o.businessAssetId ?? assetId, periodStart, periodEnd, version, network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: chainAsset.id })).json().id as string;
    for (const [side, kind, amount, ev, ref] of [["revenue", "gross_revenue", "800000", evidence.e1, "INV-1"], ["expense", "operating_expense", "300000", evidence.e2, "EXP-1"]] as const)
      expect((await call("POST", `/cycles/${id}/inputs`, "manager", { side, kind, amount, currency: "USD", completeness: "known", evidenceId: ev, sourceKind: "invoice", sourceRef: ref })).statusCode).toBe(201);
    const params = { entitlementRef: POLICY.entitlement.sha256, policyHash: await calculationPolicyHash(POLICY), formulaVersion: "yield-formula/1", accountingCurrency: "USD", settlementMint: SETTLE, settlementDecimals: 6 };
    expect((await call("PATCH", `/cycles/${id}`, "manager", params)).statusCode).toBe(200);
    const base = dossierFor({ [pa]: "01".repeat(32), [pb]: null });
    const d = o.dustThreshold === undefined ? base : { ...base, distributionPolicy: { ...base.distributionPolicy, dustThreshold: o.dustThreshold } };
    const dossier = JSON.parse(canonicalSimulationDossier(d));
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
    for (const r of ["owner", "admin", "manager", "verifier", "holder", "holder2"] as const) ids[r] = (await upsertUserBySubject(pool, { issuer: "dev", subject: who(r) })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `yp-${sfx}`, name: "Pipeline", ownerUserId: ids.owner! }));
    for (const r of ["admin", "manager", "verifier"] as const) await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [tenantId, ids[r], r]);
    for (const r of ["holder", "holder2"] as const) await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'viewer')`, [tenantId, ids[r]]);
    ({ assetId, pa, pb } = await withTenant(pool, tenantId, async (tx) => {
      const farm = (await createFarm(tx, { name: "Grove", timezone: "UTC", createdBy: ids.owner! })).id;
      const assetId = (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'farm_share', 'Shares') RETURNING id`, [tx.tenantId, farm])).rows[0]!.id;
      const pa = await createParty(tx, { kind: "person", displayName: "A", createdBy: ids.owner! });
      const pb = await createParty(tx, { kind: "organisation", displayName: "B", createdBy: ids.owner! });
      await addWallet(tx, pa, "solana-devnet", wA);
      await addWallet(tx, pb, "solana-devnet", wB);
      // Explicit, consented, authorised links (Y12): holder ↔ A, holder2 ↔ B.
      for (const [party, user] of [[pa, ids.holder!], [pb, ids.holder2!]] as const) {
        const l = await proposePartyLink(tx, { partyId: party, userId: user, proposedBy: ids.owner! });
        await consentPartyLink(tx, l.id, { userId: user, consentVersion: "draft-unapproved-1", consentSha256: h(9) });
        await authorisePartyLink(tx, l.id, ids.admin!);
      }
      return { assetId, pa, pb };
    }));
    const ev = (to: string, amount: bigint, slot: bigint): OwnershipEvent => ({ asset: chainAsset, kind: "mint", from: null, to, amount, slot, txIndex: 0, ixIndex: 0, signature: b58(64) });
    await withSystem(pool, async (tx) => {
      await insertOwnershipEvents(tx, [ev(wA, 600n, 10n), ev(wB, 300n, 11n), ev(stranger, 100n, 12n)], "fixture");
      await advanceOwnershipCursor(tx, chainAsset, 500n, "fixture");
    });
    secondAssetId = await withTenant(pool, tenantId, async (tx) => (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) SELECT tenant_id, farm_id, 'farm_share', 'Second' FROM business_assets WHERE id = $1 RETURNING id`, [assetId])).rows[0]!.id);
    ({ app } = await buildTestApp({ pool, env: { YIELD_WORKFLOW_ENABLED: "true", PARTY_LINKS_ENABLED: "true", HOLDER_YIELD_ENABLED: "true" }, deps: { yieldEngine: createPipelineYieldEngine() } }));
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
    // The frozen artifact and its leaves were persisted at calculate (0027); reads come from storage.
    const art = (await pool.query<{ ok: boolean; leaf_count: number }>(`SELECT artifact_sha256 = $2 AS ok, leaf_count FROM yield_frozen_artifacts WHERE artifact_set_id = $1`, [frozen.artifactSetId, frozen.artifactSetHash])).rows[0]!;
    expect(art).toEqual({ ok: true, leaf_count: 1 });
    const leaves = (await call("GET", `/cycles/${id}/artifact-sets/${frozen.artifactSetId}/leaves`, "verifier")).json();
    expect([leaves.root, leaves.size, leaves.items[0].partyId]).toEqual([frozen.merkleRoot, 1, pa]);
    expect(await verifyClaimLeafProof(SHA256_RFC9162_HASHER, unhex(leaves.items[0].leafBytes), leaves.items[0].proof, { root: frozen.merkleRoot, treeSize: 1 })).toBe(true);

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
    // The linked holder of A reads A's persisted proof; B (withheld) has no leaf; unlinked members see nothing.
    const me = (as: "holder" | "holder2" | "manager") => app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/me/yield/cycles/${id}/proof`, headers: { authorization: `Bearer ${tokens[as]}` } });
    const tokens = { holder: await tokenFor(who("holder")), holder2: await tokenFor(who("holder2")), manager: await tokenFor(who("manager")) };
    const p = (await me("holder")).json();
    expect([p.simulation, p.disclosureApproved, p.setHash, p.root, p.hasherPending]).toEqual([true, false, second.artifactSetHash, second.merkleRoot, "D-26"]);
    expect(p.leaf.partyId).toBeUndefined();
    expect(await verifyClaimLeafProof(SHA256_RFC9162_HASHER, unhex(p.leaf.leafBytes), p.leaf.proof, { root: p.root, treeSize: p.leaf.proof.treeSize })).toBe(true);
    expect((await me("holder2")).json().error).toBe("no_leaf");
    expect((await me("manager")).statusCode).toBe(404);
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

  it("carries deferred dust from a published cycle into the next one (G3), recorded and chained by hash", async () => {
    const asset2 = secondAssetId;
    // Cycle N: a dust threshold above A's share defers A; B is withheld, the stranger unattributed.
    const n = await preparedCycle(1, { businessAssetId: asset2, period: ["2026-07-01", "2026-09-30"], dustThreshold: 10n ** 12n });
    const cn = (await call("POST", `/cycles/${n.id}/calculate`, "manager", {})).json();
    expect(cn.status, JSON.stringify(cn)).toBe("calculated");
    const carryN = (await call("GET", `/cycles/${n.id}/artifact-sets/${cn.artifactSetId}/carry`, "manager")).json();
    expect(carryN.sourceSetId).toBeNull();
    expect(carryN.ledgerOut.deferred.map((x: { partyId: string }) => x.partyId)).toEqual([pa]);
    const deferredA = BigInt(carryN.ledgerOut.deferred[0].amount);
    await call("POST", `/cycles/${n.id}/submit`, "manager", {});
    await call("POST", `/cycles/${n.id}/attestations`, "verifier", { artifactSetId: cn.artifactSetId, attestedHash: cn.artifactSetHash, statement: "ok" });
    await call("POST", `/cycles/${n.id}/approve`, "admin", {});
    expect((await call("POST", `/cycles/${n.id}/publish`, "admin", {})).json().status).toBe("published");

    // Cycle N+1 takes N's carry-out in: A is now paid its share plus the carried dust.
    const m = await preparedCycle(1, { businessAssetId: asset2, period: ["2026-10-01", "2026-12-31"] });
    const cm = (await call("POST", `/cycles/${m.id}/calculate`, "manager", {})).json();
    const carryM = (await call("GET", `/cycles/${m.id}/artifact-sets/${cm.artifactSetId}/carry`, "manager")).json();
    expect([carryM.sourceSetId, carryM.ledgerIn.sha256]).toEqual([cn.artifactSetId, carryN.ledgerOut.sha256]);
    expect(carryM.ledgerOut).toMatchObject({ carriedRemainder: "0", deferred: [] });
    const rows = (await call("GET", `/cycles/${m.id}/artifact-sets/${cm.artifactSetId}/allocations`, "manager")).json().items as { kind: string; partyId: string | null; amount: string }[];
    const plain = (await call("POST", `/cycles/${(await preparedCycle(15)).id}/preview`, "manager", {}).then((r) => r.json())) as { allocations: { partyId: string | null; amount: string }[] };
    const aNow = BigInt(rows.find((r) => r.partyId === pa)!.amount);
    const aPlain = BigInt(plain.allocations.find((r) => r.partyId === pa)!.amount);
    expect(aNow - aPlain).toBe(deferredA);
    expect((await call("GET", `/cycles/${m.id}/reconciliation`, "manager")).json()).toMatchObject({ consistent: true });
  });
});
