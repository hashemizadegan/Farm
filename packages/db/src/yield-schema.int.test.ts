/**
 * Y7 against PostgreSQL: the yield schema's state machine, frozen artifact sets, four-eyes, D-17 database-level
 * fixture exclusion, the real gate, append-only history, tenant isolation and the repository's stable codes.
 * Offline: nothing contacts a chain.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "./pool";
import { EMPTY_LEDGER, frozenNoLeaves, sha256, testArtifact } from "./yield-calc.test-support";
import { migrateUp } from "./migrate";
import { withSystem, withTenant, type TenantTx } from "./tenant";
import { createTenantWithOwner, upsertUserBySubject } from "./repositories/identity";
import { createFarm } from "./repositories/farms";
import { createParty } from "./repositories/rwa";
import { registerOwnershipSourceIdentity } from "./repositories/ownership-index";
import {
  activeYieldAttesters,
  addYieldAttestation,
  addYieldInput,
  createYieldCycle,
  getYieldOwnershipSnapshot,
  listYieldAllocations,
  listYieldArtifactSets,
  listYieldCycleTransitions,
  listYieldCycles,
  recordCalculation,
  reconcileYieldCycle,
  getFrozenArtifact,
  getYieldCarry,
  yieldCarryIn,
  registerYieldEvidence,
  setYieldCycleParameters,
  toYieldStoreError,
  transitionYieldCycle,
  type YieldCalculationRecord,
  type YieldStoreError,
} from "./repositories/yield";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MINT = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = () => Array.from(randomBytes(44), (b) => ALPH[b % 58]).join("");
const h = (c: string) => c.repeat(64);
const SET_A = testArtifact("a").setHash;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    // Raw SQL in these tests raises PostgreSQL errors: read them through the repository's mapping.
    const m = toYieldStoreError(e) as YieldStoreError;
    return m instanceof Error && m.name === "YieldStoreError" ? m.code : `uncoded: ${(e as Error).message}`;
  }
  return "no error";
}

d("yield schema (Y7)", () => {
  let pool: Pool;
  let tenant: string;
  let other: string;
  let preparer: string;
  let reviewer: string;
  let asset: string;
  let party: string;
  let identity: string;
  const inT = <T>(fn: (tx: TenantTx) => Promise<T>, t = tenant) => withTenant(pool, t, fn);
  const params = { entitlementRef: h("a"), policyHash: h("b"), formulaVersion: "f1/2026", accountingCurrency: "EUR", settlementMint: MINT, settlementDecimals: 6 };
  /** A calculation record; its frozen artifact is the text for `tag` (0027), its carry the genesis carry (0028). */
  const calc = (over: Partial<YieldCalculationRecord> = {}, snap: Partial<YieldCalculationRecord["snapshot"]> = {}, tag = "a"): YieldCalculationRecord => ({
    calculationHash: h("1"),
    allocationHash: h("2"),
    evidenceBundleHash: h("3"),
    merkleRoot: h("4"),
    ...frozenNoLeaves(tag),
    snapshot: { sourceKind: "fixture", sourceIdentityId: null, cursorSlot: 300n, holdingModel: "slot_weighted", inputCommitment: h("6"), totalWeight: 100n, ...snap },
    allocations: [
      { kind: "allocated", partyId: party, weight: 90n, amount: 900n },
      { kind: "unattributed", holderKey: MINT, weight: 10n, amount: 100n },
    ],
    actorUserId: preparer,
    ...over,
  });
  let versions = 1;
  /** A cycle in inputs_locked with its slot range set. */
  const lockedCycle = async (simulation: boolean) =>
    inT(async (tx) => {
      const c = await createYieldCycle(tx, { businessAssetId: asset, periodStart: "2026-01-01", periodEnd: "2026-03-31", version: ++versions, simulation, network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: MINT, createdBy: preparer });
      await setYieldCycleParameters(tx, c.id, params, preparer);
      await transitionYieldCycle(tx, c.id, { to: "inputs_locked", actorUserId: preparer, reason: "period ended" });
      await setYieldCycleParameters(tx, c.id, { slotStart: 100n, slotEnd: 200n }, preparer);
      return c.id;
    });

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
    const sfx = Math.random().toString(36).slice(2, 8);
    preparer = (await upsertUserBySubject(pool, { issuer: "test", subject: `y7p-${sfx}` })).id;
    reviewer = (await upsertUserBySubject(pool, { issuer: "test", subject: `y7r-${sfx}` })).id;
    tenant = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `y7-${sfx}`, name: "Y7", ownerUserId: preparer }));
    other = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `y7o-${sfx}`, name: "Y7 other", ownerUserId: preparer }));
    const farm = (await inT((tx) => createFarm(tx, { name: "Grove", timezone: "UTC", createdBy: preparer }))).id;
    asset = await inT(async (tx) => (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'farm_share', 'Grove shares') RETURNING id`, [tx.tenantId, farm])).rows[0]!.id);
    party = await inT((tx) => createParty(tx, { kind: "person", displayName: "Holder", createdBy: preparer }));
    identity = (await withSystem(pool, (tx) => registerOwnershipSourceIdentity(tx, { network: "solana-devnet", genesisHash: DEVNET, endpointScheme: "https", endpointHost: `y7-${sfx}.invalid`, verifiedBy: "test" }))).id.toString();
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("runs a simulation cycle from draft to closed, with four-eyes, frozen sets and a complete history", async () => {
    const id = await inT(async (tx) => {
      const c = await createYieldCycle(tx, { businessAssetId: asset, periodStart: "2026-04-01", periodEnd: "2026-06-30", network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: MINT, createdBy: preparer });
      expect([c.status, c.simulation]).toEqual(["draft", true]);
      expect(await code(transitionYieldCycle(tx, c.id, { to: "inputs_locked", actorUserId: preparer }))).toBe("lock_incomplete");
      const ev = await registerYieldEvidence(tx, { contentSha256: h("e"), evidenceType: "invoice", classification: "internal", simulation: true, createdBy: preparer });
      await addYieldInput(tx, c.id, { side: "revenue", kind: "sale", amount: 1000n, currency: "EUR", completeness: "known", evidenceId: ev, sourceKind: "invoice", sourceRef: "INV-1", createdBy: preparer });
      expect(await code(addYieldInput(tx, c.id, { side: "revenue", kind: "sale", amount: 1n, currency: "EUR", completeness: "known", sourceKind: "invoice", sourceRef: "INV-1", createdBy: preparer }))).toBe("duplicate");
      await setYieldCycleParameters(tx, c.id, params, preparer);
      await transitionYieldCycle(tx, c.id, { to: "inputs_locked", actorUserId: preparer, reason: "period ended" });
      expect(await code(setYieldCycleParameters(tx, c.id, { policyHash: h("c") }, preparer))).toBe("frozen");
      expect(await code(addYieldInput(tx, c.id, { side: "expense", kind: "fuel", amount: 1n, currency: "EUR", completeness: "known", sourceKind: "invoice", sourceRef: "INV-2", createdBy: preparer }))).toBe("cycle_not_draft");
      await setYieldCycleParameters(tx, c.id, { slotStart: 100n, slotEnd: 200n }, preparer);
      return c.id;
    });
    const { artifactSetId } = await inT((tx) => recordCalculation(tx, id, calc()));
    await inT(async (tx) => {
      expect(await code(setYieldCycleParameters(tx, id, { slotEnd: 250n }, preparer))).toBe("frozen");
      expect((await getYieldOwnershipSnapshot(tx, artifactSetId))!.sourceKind).toBe("fixture");
      expect((await listYieldAllocations(tx, artifactSetId)).map((a) => [a.kind, a.amount])).toEqual([["allocated", 900n], ["unattributed", 100n]]);
      expect(await code(transitionYieldCycle(tx, id, { to: "published", actorUserId: reviewer }))).toBe("invalid_transition");
      await transitionYieldCycle(tx, id, { to: "under_review", actorUserId: preparer });
      expect(await code(addYieldAttestation(tx, { artifactSetId, attesterUserId: reviewer, kind: "attest", attestedHash: h("0"), statement: "checked" }))).toBe("attestation_mismatch");
      await addYieldAttestation(tx, { artifactSetId, attesterUserId: reviewer, kind: "attest", attestedHash: SET_A, statement: "checked" });
      expect(await activeYieldAttesters(tx, artifactSetId)).toEqual([reviewer]);
      expect(await code(transitionYieldCycle(tx, id, { to: "approved", actorUserId: preparer }))).toBe("four_eyes");
      await transitionYieldCycle(tx, id, { to: "approved", actorUserId: reviewer });
      await transitionYieldCycle(tx, id, { to: "published", actorUserId: reviewer });
      await transitionYieldCycle(tx, id, { to: "disputed", actorUserId: reviewer, reason: "holder dispute" });
      expect((await transitionYieldCycle(tx, id, { to: "published", actorUserId: reviewer, reason: "dismissed" })).command).toBe("dismiss");
      expect(await code(transitionYieldCycle(tx, id, { to: "funded", actorUserId: reviewer }))).toBe("future_phase");
      const closed = await transitionYieldCycle(tx, id, { to: "closed", actorUserId: reviewer, closeReason: "simulation" });
      expect([closed.cycle.status, closed.cycle.closeReason]).toEqual(["closed", "simulation"]);
      expect((await listYieldCycleTransitions(tx, id)).map((t) => `${t.command}:${t.actorUserId === reviewer ? "R" : t.actorUserId === preparer ? "P" : "-"}`)).toEqual([
        "create:P", "lock:P", "calculate:P", "submit:P", "approve:R", "publish:R", "dispute:R", "dismiss:R", "close:R",
      ]);
      expect((await listYieldArtifactSets(tx, id)).map((s) => s.status)).toEqual(["approved"]);
      const audit = await tx.query<{ action: string }>(`SELECT action FROM audit_events WHERE tenant_id = $1 AND target_id = $2 AND action LIKE 'yield.cycle.%' ORDER BY id`, [tenant, id]);
      expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["yield.cycle.create", "yield.cycle.calculate", "yield.cycle.approve", "yield.cycle.close"]));
    });
  });

  it("D-17 layer 2: a non-simulation cycle refuses fixture ownership, and the real gate stops it at inputs_locked; nothing is written", async () => {
    const real = await lockedCycle(false);
    expect(await code(inT((tx) => recordCalculation(tx, real, calc())))).toBe("fixture_in_real_cycle");
    expect(await code(inT((tx) => recordCalculation(tx, real, calc({}, { sourceKind: "rpc", sourceIdentityId: null }))))).toBe("unverified_source");
    expect(await code(inT((tx) => recordCalculation(tx, real, calc({}, { sourceKind: "rpc", sourceIdentityId: identity }))))).toBe("real_gate");
    await inT(async (tx) => {
      expect(await listYieldArtifactSets(tx, real)).toEqual([]);
      expect((await tx.query(`SELECT 1 FROM yield_ownership_snapshots WHERE cycle_id = $1`, [real])).rowCount).toBe(0);
    });
    // A simulation cycle may use an RPC snapshot bound to a verified identity.
    const sim = await lockedCycle(true);
    const r = await inT((tx) => recordCalculation(tx, sim, calc({}, { sourceKind: "rpc", sourceIdentityId: identity })));
    expect(r.cycle.status).toBe("calculated");
  });

  it("unlock and reject invalidate the frozen set (kept); recalculation adds a new set", async () => {
    const id = await lockedCycle(true);
    const first = await inT((tx) => recordCalculation(tx, id, calc()));
    await inT((tx) => transitionYieldCycle(tx, id, { to: "inputs_locked", actorUserId: preparer, reason: "correction" }));
    const second = await inT((tx) => recordCalculation(tx, id, calc({ merkleRoot: h("7"), actorUserId: reviewer }, {}, "b")));
    expect(second.cycle.preparedBy).toBe(reviewer);
    await inT((tx) => transitionYieldCycle(tx, id, { to: "under_review", actorUserId: reviewer }));
    // The approver may not be the preparer (reviewer here) nor the creator (preparer).
    expect(await code(inT((tx) => transitionYieldCycle(tx, id, { to: "approved", actorUserId: reviewer })))).toBe("four_eyes");
    expect(await code(inT((tx) => transitionYieldCycle(tx, id, { to: "approved", actorUserId: preparer })))).toBe("four_eyes");
    await inT((tx) => transitionYieldCycle(tx, id, { to: "inputs_locked", actorUserId: preparer, reason: "rejected" }));
    const sets = await inT((tx) => listYieldArtifactSets(tx, id));
    expect(sets.map((s) => [s.id, s.setNumber, s.status])).toEqual([
      [first.artifactSetId, 1, "invalidated"],
      [second.artifactSetId, 2, "invalidated"],
    ]);
    expect(await code(inT((tx) => transitionYieldCycle(tx, id, { to: "inputs_locked", actorUserId: null })))).toBe("invalid_transition");
    expect((await inT((tx) => transitionYieldCycle(tx, id, { to: "abandoned", actorUserId: null }))).command).toBe("expire");
  });

  it("history is append-only and sets move only through the cycle: the application role cannot edit or delete", async () => {
    const id = await lockedCycle(true);
    const { artifactSetId } = await inT((tx) => recordCalculation(tx, id, calc()));
    const sql = (q: string, p: unknown[]) => inT((tx) => tx.query(q, p));
    expect(await code(sql(`UPDATE yield_artifact_sets SET status = 'invalidated' WHERE id = $1`, [artifactSetId]))).toBe("forbidden");
    expect(await code(sql(`INSERT INTO yield_cycle_transitions (tenant_id, cycle_id, command, to_state) VALUES ($1, $2, 'x', 'published')`, [tenant, id]))).toBe("forbidden");
    expect(await code(sql(`DELETE FROM yield_cycles WHERE id = $1`, [id]))).toBe("forbidden");
    expect(await code(sql(`UPDATE yield_allocations SET amount = 0 WHERE artifact_set_id = $1`, [artifactSetId]))).toBe("forbidden");
    expect(await code(sql(`UPDATE yield_cycles SET simulation = false WHERE id = $1`, [id]))).toBe("immutable");
    // Even the owner role (no RLS, all grants) cannot rewrite history: the triggers refuse.
    expect(await code(pool.query(`UPDATE yield_ownership_snapshots SET total_weight = 1 WHERE artifact_set_id = $1`, [artifactSetId]))).toBe("forbidden");
    expect(await code(pool.query(`DELETE FROM yield_cycle_transitions WHERE cycle_id = $1`, [id]))).toBe("forbidden");
    expect(await code(pool.query(`UPDATE yield_artifact_sets SET merkle_root = $2 WHERE id = $1`, [artifactSetId, h("9")]))).toBe("immutable");
  });

  it("isolates tenants and refuses double counting across live real cycles; simulation records stay out of real cycles", async () => {
    expect(await inT((tx) => listYieldCycles(tx, { limit: 50 }), other)).toEqual([]);
    const realA = await inT(async (tx) => (await createYieldCycle(tx, { businessAssetId: asset, periodStart: "2025-01-01", periodEnd: "2025-03-31", simulation: false, network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: MINT, createdBy: preparer })).id);
    const realB = await inT(async (tx) => (await createYieldCycle(tx, { businessAssetId: asset, periodStart: "2025-04-01", periodEnd: "2025-06-30", simulation: false, network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: MINT, createdBy: preparer })).id);
    const line = { side: "revenue" as const, kind: "sale", amount: 5n, currency: "EUR", completeness: "known" as const, sourceKind: "invoice", sourceRef: `INV-${b58().slice(0, 8)}`, createdBy: preparer };
    await inT((tx) => addYieldInput(tx, realA, line));
    expect(await code(inT((tx) => addYieldInput(tx, realB, line)))).toBe("double_counted");
    const ev = await inT((tx) => registerYieldEvidence(tx, { contentSha256: h("f"), evidenceType: "receipt", classification: "internal", simulation: true, createdBy: preparer }));
    expect(await code(inT((tx) => addYieldInput(tx, realB, { ...line, sourceRef: "other", evidenceId: ev })))).toBe("simulation_record_in_real_cycle");
    expect(await code(inT((tx) => registerYieldEvidence(tx, { contentSha256: h("d"), evidenceType: "receipt", classification: "internal", simulation: false, createdBy: preparer })))).toBe("evidence_retention_unapproved");
    // Another tenant cannot see or extend this tenant's cycle.
    expect(await code(inT((tx) => addYieldInput(tx, realA, { ...line, sourceRef: "x" }), other))).toBe("not_found");
  });

  it("reconciles a cycle's records (Y14): consistent when written through the repository, findings otherwise", async () => {
    const good = await lockedCycle(true);
    await inT((tx) => recordCalculation(tx, good, calc()));
    expect((await inT((tx) => reconcileYieldCycle(tx, good))).findings).toEqual([]);
    // Weights that do not add up to the snapshot's total.
    const bad = await lockedCycle(true);
    await inT((tx) => recordCalculation(tx, bad, calc({ allocations: [{ kind: "allocated", partyId: party, weight: 50n, amount: 1n }] })));
    expect((await inT((tx) => reconcileYieldCycle(tx, bad))).findings.map((f) => f.code)).toEqual(["weights_do_not_sum"]);
    // A step taken outside the repository has no audit event (D-31).
    const raw = await lockedCycle(true);
    await inT((tx) => tx.query(`UPDATE yield_cycles SET status = 'cancelled', status_changed_by = $2 WHERE id = $1`, [raw, preparer]));
    expect((await inT((tx) => reconcileYieldCycle(tx, raw))).findings).toEqual([{ code: "audit_missing", detail: "1 cancel step(s) logged, 0 audited" }]);
    expect(await code(inT((tx) => reconcileYieldCycle(tx, "00000000-0000-4000-8000-000000000000")))).toBe("not_found");
  });

  // ── G2: frozen artifacts persisted at calculate (0027) ──

  it("persists the frozen artifact at calculate; a second calculate without unlock is refused and adds nothing", async () => {
    const id = await lockedCycle(true);
    const { artifactSetId } = await inT((tx) => recordCalculation(tx, id, calc()));
    const stored = await inT((tx) => getFrozenArtifact(tx, artifactSetId));
    expect(stored).toMatchObject({ sha256: SET_A, leafCount: 0, body: testArtifact("a").body });
    const count = async () => (await pool.query<{ n: number }>(`SELECT (SELECT count(*) FROM yield_artifact_sets WHERE cycle_id = $1) + (SELECT count(*) FROM yield_frozen_artifacts WHERE cycle_id = $1) + (SELECT count(*) FROM yield_carry_ledgers WHERE cycle_id = $1) AS n`, [id])).rows[0]!.n;
    const before = await count();
    expect(await code(inT((tx) => recordCalculation(tx, id, calc({}, {}, "b"))))).toBe("not_calculating");
    expect(await count()).toBe(before);
    // Immutable, even for the owner role.
    expect(await code(pool.query(`UPDATE yield_frozen_artifacts SET scheme = 'x' WHERE artifact_set_id = $1`, [artifactSetId]))).toBe("forbidden");
  });

  it("refuses a frozen artifact that does not hash to the set hash, and a calculate without one; nothing is stored", async () => {
    const id = await lockedCycle(true);
    const wrong = { ...calc(), frozen: { ...calc().frozen, body: "not the artifact" } };
    expect(await code(inT((tx) => recordCalculation(tx, id, wrong)))).toBe("artifact_mismatch");
    expect((await inT((tx) => listYieldArtifactSets(tx, id))).length).toBe(0);
    // Straight SQL, without the repository: the cycle cannot reach calculated without its frozen artifact.
    const set = await inT(async (tx) => {
      const s = (await tx.query<{ id: string }>(`INSERT INTO yield_artifact_sets (tenant_id, cycle_id, set_number, calculation_hash, allocation_hash, evidence_bundle_hash, merkle_root, set_hash, created_by) VALUES ($1, $2, 1, $3, $3, $3, $3, $4, $5) RETURNING id`, [tenant, id, h("1"), SET_A, preparer])).rows[0]!.id;
      await tx.query(`INSERT INTO yield_ownership_snapshots (tenant_id, cycle_id, artifact_set_id, source_kind, network, rail, chain_asset_id, slot_start, slot_end, cursor_slot, holding_model, input_commitment, total_weight) VALUES ($1, $2, $3, 'fixture', 'solana-devnet', 'SOLANA_TOKEN_2022', $4, 100, 200, 300, 'slot_weighted', $5, 1)`, [tenant, id, s, MINT, h("6")]);
      return s;
    });
    const r = inT((tx) => tx.query(`UPDATE yield_cycles SET status = 'calculated', status_changed_by = $2, artifact_set_hash = $3, merkle_root = $4 WHERE id = $1`, [id, preparer, SET_A, h("1")]));
    expect(await code(r)).toBe("artifact_missing");
    expect(set).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── G3: carry-forward between consecutive simulation cycles (0028) ──

  it("chains carry-forward in period order: genesis, then the published predecessor's carry-out; open predecessors block", async () => {
    // A separate asset, so earlier tests' cycles are not predecessors.
    const asset2 = await inT(async (tx) => (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) SELECT tenant_id, farm_id, 'farm_share', 'Chain' FROM business_assets WHERE id = $1 RETURNING id`, [asset])).rows[0]!.id);
    const cycleIn = (start: string, end: string) =>
      inT(async (tx) => {
        const c = await createYieldCycle(tx, { businessAssetId: asset2, periodStart: start, periodEnd: end, network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: MINT, createdBy: preparer });
        await setYieldCycleParameters(tx, c.id, params, preparer);
        await transitionYieldCycle(tx, c.id, { to: "inputs_locked", actorUserId: preparer });
        await setYieldCycleParameters(tx, c.id, { slotStart: 100n, slotEnd: 200n }, preparer);
        return c.id;
      });
    const OUT1 = `{"carriedRemainder":"3","deferred":[{"amount":"7","partyId":"${party}"}]}`;
    const carry = (sourceSetId: string | null, inBody: string, outBody = EMPTY_LEDGER) => ({ sourceSetId, ledgerIn: { body: inBody, sha256: sha256(inBody) }, ledgerOut: { body: outBody, sha256: sha256(outBody) } });

    const q1 = await cycleIn("2027-01-01", "2027-03-31");
    expect(await inT((tx) => yieldCarryIn(tx, q1))).toEqual({ sourceSetId: null, ledger: null });
    const r1 = await inT((tx) => recordCalculation(tx, q1, { ...calc({}, {}, "q1"), carry: carry(null, EMPTY_LEDGER, OUT1) }));
    const q2 = await cycleIn("2027-04-01", "2027-06-30");
    // Q1 is not published yet: Q2 has no predecessor.
    expect((await inT((tx) => yieldCarryIn(tx, q2))).sourceSetId).toBeNull();
    await inT(async (tx) => {
      await transitionYieldCycle(tx, q1, { to: "under_review", actorUserId: preparer });
      await transitionYieldCycle(tx, q1, { to: "approved", actorUserId: reviewer });
      await transitionYieldCycle(tx, q1, { to: "published", actorUserId: reviewer });
    });
    expect(await inT((tx) => yieldCarryIn(tx, q2))).toEqual({ sourceSetId: r1.artifactSetId, ledger: { body: OUT1, sha256: sha256(OUT1) } });
    // The wrong source, or a carry-in that is not Q1's carry-out, is refused; nothing is stored.
    expect(await code(inT((tx) => recordCalculation(tx, q2, { ...calc({}, {}, "q2"), carry: carry(null, EMPTY_LEDGER) })))).toBe("carry_source_mismatch");
    expect(await code(inT((tx) => recordCalculation(tx, q2, { ...calc({}, {}, "q2"), carry: carry(r1.artifactSetId, EMPTY_LEDGER) })))).toBe("carry_mismatch");
    expect((await inT((tx) => listYieldArtifactSets(tx, q2))).length).toBe(0);
    const r2 = await inT((tx) => recordCalculation(tx, q2, { ...calc({}, {}, "q2"), carry: carry(r1.artifactSetId, OUT1) }));
    expect(await inT((tx) => getYieldCarry(tx, r2.artifactSetId))).toMatchObject({ sourceSetId: r1.artifactSetId, ledgerIn: { sha256: sha256(OUT1) } });
    // Q3 while Q2 is still open: Q1's carry-out would be consumed twice. Refused.
    const q3 = await cycleIn("2027-07-01", "2027-09-30");
    expect(await code(inT((tx) => recordCalculation(tx, q3, { ...calc({}, {}, "q3"), carry: carry(r1.artifactSetId, OUT1) })))).toBe("carry_predecessor_open");
    // A correction of Q1 (version 2) is not a predecessor of itself: it takes the same (genesis) carry-in as Q1.
    expect((await inT((tx) => yieldCarryIn(tx, q1))).sourceSetId).toBeNull();
    // Carry rows are immutable.
    expect(await code(pool.query(`DELETE FROM yield_carry_ledgers WHERE cycle_id = $1`, [q1]))).toBe("forbidden");
  });

  it("refuses frozen artifacts and carry rows for real cycles", async () => {
    const real = await lockedCycle(false);
    expect(await code(inT((tx) => recordCalculation(tx, real, calc({}, { sourceKind: "rpc", sourceIdentityId: identity }))))).toBe("real_gate");
    expect((await pool.query(`SELECT 1 FROM yield_frozen_artifacts WHERE cycle_id = $1 UNION ALL SELECT 1 FROM yield_carry_ledgers WHERE cycle_id = $1`, [real])).rowCount).toBe(0);
  });
});
