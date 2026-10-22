/**
 * Line join: the yield pipeline as the Y9 calculation engine. A complete simulation scenario through the real
 * yield domain (waterfall, evidence ledger, snapshot, distribution, claim tree), its determinism, and every
 * fail-closed refusal of the adapter. Offline; no database, no network.
 */
import { describe, expect, it } from "vitest";
import { base58Encode } from "@metafarm/chain";
import type { YieldCycleRow, YieldInputRow } from "@metafarm/db";
import { buildWeightedOwnershipInput, type ChainAssetRef, type OwnershipEvent, type WeightedOwnershipInput } from "@metafarm/domain";
import {
  EMPTY_CARRY_LEDGER,
  SHA256_RFC9162_HASHER,
  calculationPolicyHash,
  carryLedgerHash,
  parseCarryLedger,
  verifyClaimLeafProof,
  canonicalSimulationDossier,
  parseSimulationDossier,
  simulationDossierHash,
} from "@metafarm/domain/yield";
import { engineOutputProblems, type YieldCalculationRequest } from "./lib/yield-engine";
import { POLICY, dossierFor, h, item } from "./test/yield-dossier";
import { EMPTY_TREE_ROOT, allocationsOf, createPipelineYieldEngine, uuidFromDigest } from "./lib/yield-pipeline-engine";

const key = (b: number) => base58Encode(new Uint8Array(32).fill(b));
const MINT = key(40);
const SETTLE = "So11111111111111111111111111111111111111112";
const [WA, WB, STRANGER] = [key(41), key(42), key(43)];
const PA = "00000000-0000-4000-8000-0000000000aa";
const PB = "00000000-0000-4000-8000-0000000000bb";
const asset: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: MINT };

const DOSSIER = dossierFor({ [PA]: "01".repeat(32), [PB]: null });

const INPUTS: YieldInputRow[] = [
  { id: "1", side: "revenue", kind: "gross_revenue", amount: 800_000n, currency: "USD", completeness: "known", evidenceId: "e1", sourceKind: "invoice", sourceRef: "INV-1" },
  { id: "2", side: "expense", kind: "operating_expense", amount: 300_000n, currency: "USD", completeness: "known", evidenceId: "e2", sourceKind: "invoice", sourceRef: "EXP-1" },
];

async function cycle(over: Partial<YieldCycleRow> = {}): Promise<YieldCycleRow> {
  return {
    id: "00000000-0000-4000-8000-0000000000c1",
    businessAssetId: "00000000-0000-4000-8000-0000000000a1",
    periodStart: "2026-01-01",
    periodEnd: "2026-03-31",
    version: 1,
    simulation: true,
    status: "inputs_locked",
    priorStatus: null,
    closeReason: null,
    network: "solana-devnet",
    rail: "SOLANA_TOKEN_2022",
    chainAssetId: MINT,
    entitlementRef: POLICY.entitlement.sha256,
    policyHash: await calculationPolicyHash(POLICY),
    formulaVersion: "yield-formula/1",
    accountingCurrency: "USD",
    settlementMint: SETTLE,
    settlementDecimals: 6,
    slotStart: 100n,
    slotEnd: 200n,
    artifactSetHash: null,
    merkleRoot: null,
    preparedBy: null,
    createdBy: "00000000-0000-4000-8000-000000000001",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

let sig = 0;
const mint = (to: string, amount: bigint, slot: bigint): OwnershipEvent => ({ asset, kind: "mint", from: null, to, amount, slot, txIndex: 0, ixIndex: 0, signature: `sig${++sig}` });

async function ownership(sourceKind: "fixture" | "rpc" = "fixture"): Promise<WeightedOwnershipInput> {
  return buildWeightedOwnershipInput({
    history: {
      asset,
      events: [mint(WA, 600n, 10n), mint(WB, 300n, 11n), mint(STRANGER, 100n, 12n)],
      provenance: sourceKind === "fixture" ? { sourceKind, sourceIdentity: null, cursorSlot: 300n } : { sourceKind, sourceIdentity: { id: "1", network: "solana-devnet", genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }, cursorSlot: 300n },
    },
    window: { startSlot: 100n, endSlot: 200n },
    partyOfWallet: new Map([
      [WA, PA],
      [WB, PB],
    ]),
    simulation: true,
  });
}

const genesis = async () => ({ sourceSetId: null, ledger: EMPTY_CARRY_LEDGER, sha256: await carryLedgerHash(EMPTY_CARRY_LEDGER) });

async function request(over: Partial<YieldCalculationRequest> = {}): Promise<YieldCalculationRequest> {
  return { cycle: await cycle(), inputs: INPUTS, ownership: await ownership(), dossier: DOSSIER, evidenceSha256ByInput: { "1": h(1), "2": h(2) }, carryIn: await genesis(), ...over };
}
const unhex = (x: string) => Uint8Array.from(x.match(/../g)!.map((b) => parseInt(b, 16)));

const engine = createPipelineYieldEngine();
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
  return "no error";
}

describe("the yield pipeline as the calculation engine (line join)", () => {
  it("calculates a simulation cycle through the yield domain: payable, withheld and unattributed, conserved", async () => {
    const req = await request();
    const out = await engine.calculate(req);
    expect(engineOutputProblems(req, out)).toEqual([]);
    const by = Object.fromEntries(out.allocations.map((a) => [a.partyId ?? a.holderKey ?? a.kind, a]));
    expect([by[PA]!.kind, by[PB]!.kind, by[STRANGER]!.kind]).toEqual(["allocated", "withheld", "unattributed"]);
    expect([by[PA]!.weight, by[PB]!.weight, by[STRANGER]!.weight]).toEqual([60_000n, 30_000n, 10_000n]);
    // Shares 6 : 3 : 1, and every base unit accounted for.
    expect(by[PA]!.amount).toBe(2n * by[PB]!.amount);
    expect(by[PB]!.amount).toBe(3n * by[STRANGER]!.amount);
    expect(out.allocations.reduce((n, a) => n + a.amount, 0n).toString()).toBe(out.totals.inflow);
    expect(BigInt(out.totals.inflow!) > 0n).toBe(true);
    for (const k of ["calculationHash", "allocationHash", "evidenceBundleHash", "merkleRoot", "setHash"] as const) expect(out[k]).toMatch(/^[0-9a-f]{64}$/);
    expect(out.merkleRoot).not.toBe(EMPTY_TREE_ROOT);
  });

  it("is deterministic: the same locked records give the same frozen hashes, whatever the line order", async () => {
    const own = await ownership();
    const a = await engine.calculate(await request({ ownership: own }));
    const b = await engine.calculate(await request({ ownership: own, dossier: { ...DOSSIER, lines: [...DOSSIER.lines].reverse(), evidence: [...DOSSIER.evidence].reverse() }, inputs: [...INPUTS].reverse() }));
    expect([b.setHash, b.calculationHash, b.allocationHash, b.merkleRoot]).toEqual([a.setHash, a.calculationHash, a.allocationHash, a.merkleRoot]);
    // A different cycle version changes the leaves (and so the set).
    const v2 = await engine.calculate(await request({ ownership: own, cycle: await cycle({ version: 2 }) }));
    expect(v2.setHash).not.toBe(a.setHash);
    // Other ownership events (another history with the same balances) are another snapshot, so other leaves.
    const other = await engine.calculate(await request());
    expect(other.calculationHash).toBe(a.calculationHash);
    expect(other.setHash).not.toBe(a.setHash);
  });

  it("uses the empty-tree root when nothing is payable (a loss cycle)", async () => {
    const loss = { ...DOSSIER, lines: [DOSSIER.lines[0]!, { ...DOSSIER.lines[1]!, amount: 900_000n }] };
    const out = await engine.calculate(await request({ dossier: loss, inputs: [INPUTS[0]!, { ...INPUTS[1]!, amount: 900_000n }] }));
    expect(out.merkleRoot).toBe(EMPTY_TREE_ROOT);
    expect(out.totals.inflow).toBe("0");
  });

  it("fails closed with stable codes", async () => {
    expect(await code(engine.calculate(await request({ cycle: await cycle({ simulation: false }) })))).toBe("simulation_only");
    expect(await code(engine.calculate(await request({ dossier: null })))).toBe("dossier_missing");
    expect(await code(engine.calculate(await request({ ownership: await ownership("rpc") })))).toBe("real_network_ownership");
    expect(await code(engine.calculate(await request({ cycle: await cycle({ policyHash: h(9) }) })))).toBe("dossier_mismatch");
    expect(await code(engine.calculate(await request({ cycle: await cycle({ accountingCurrency: "EUR" }) })))).toBe("dossier_mismatch");
    expect(await code(engine.calculate(await request({ inputs: [INPUTS[0]!, { ...INPUTS[1]!, amount: 1n }] })))).toBe("dossier_mismatch");
    expect(await code(engine.calculate(await request({ evidenceSha256ByInput: { "1": h(1), "2": null } })))).toBe("dossier_mismatch");
    expect(await code(engine.calculate(await request({ dossier: { ...DOSSIER, evidence: [...DOSSIER.evidence, item(3, "EXTRA")] } })))).toBe("dossier_mismatch");
    expect(await code(engine.calculate(await request({ dossier: { ...DOSSIER, payoutAddresses: { [PA]: "01".repeat(32) } } })))).toBe("dossier_incomplete");
    expect(await code(engine.calculate(await request({ dossier: { ...DOSSIER, distributionLedger: { carriedRemainder: 1n, deferred: [] } } })))).toBe("carry_from_dossier_refused");
    expect(await code(engine.calculate(await request({ carryIn: { sourceSetId: null, ledger: { carriedRemainder: 5n, deferred: [] }, sha256: await carryLedgerHash(EMPTY_CARRY_LEDGER) } })))).toBe("carry_mismatch");
    const huge = await ownership();
    const big = { ...huge, parties: huge.parties.map((p, i) => (i === 0 ? { ...p, weight: 2n ** 64n } : p)) };
    expect(await code(engine.calculate(await request({ ownership: big })))).toBe("weight_exceeds_u64");
    // A refusal inside the yield domain surfaces as calculation_refused (here: a retention class the simulation storage policy does not allow).
    expect(await code(engine.calculate(await request({ dossier: { ...DOSSIER, evidence: [{ ...item(1, "INV-1"), retentionClassId: "other" }, item(2, "EXP-1")] } })))).toBe("calculation_refused");
  });

  it("keeps the dossier simulation-only and content-addressed", async () => {
    const text = canonicalSimulationDossier(DOSSIER);
    const back = parseSimulationDossier(text);
    expect(await simulationDossierHash(back)).toBe(await simulationDossierHash(DOSSIER));
    expect(canonicalSimulationDossier(back)).toBe(text);
    expect(await code(Promise.resolve().then(() => parseSimulationDossier({ ...JSON.parse(text), calculationPolicy: { ...JSON.parse(text).calculationPolicy, status: "approved" } })))).toBe("not_simulation");
    expect(await code(Promise.resolve().then(() => parseSimulationDossier({ ...JSON.parse(text), extra: 1 })))).toBe("invalid_dossier");
    expect(await code(Promise.resolve().then(() => parseSimulationDossier("{"))).then((c) => c)).toBe("invalid_dossier");
  });

  it("derives deterministic snapshot ids and folds deferred dust into one weighted row", () => {
    expect(uuidFromDigest("f".repeat(64))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    const rows = allocationsOf({
      totals: { inflow: 10n, leaves: 6n, dustCarriedForward: 3n, withheld: 0n, unattributed: 0n, remainderCarried: 1n },
      distribution: {
        planSha256: "",
        plan: {
          entries: [
            { kind: "party", partyId: "a", holderKey: null, payoutWallet: "x", weight: 6n, allocated: 6n, deferredIn: 0n, amount: 6n, state: "payable", deferredReason: null },
            { kind: "party", partyId: "d", holderKey: null, payoutWallet: "y", weight: 1n, allocated: 3n, deferredIn: 0n, amount: 3n, state: "deferred", deferredReason: "below_dust_threshold" },
          ],
        },
      },
    } as never);
    expect(rows).toEqual([
      { kind: "allocated", partyId: "a", weight: 6n, amount: 6n },
      { kind: "dust", weight: 1n, amount: 4n },
    ]);
  });

  it("returns the frozen artifact: its canonical text hashes to the set hash, its leaves pay the allocations and verify", async () => {
    const out = await engine.calculate(await request());
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(out.frozen.body, "utf8").digest("hex")).toBe(out.setHash);
    expect(JSON.parse(out.frozen.body).scheme).toBe(out.frozen.scheme);
    expect(out.frozen.leaves).toHaveLength(1); // only party A is payable (B withheld, the stranger unattributed)
    const leaf = out.frozen.leaves[0]!;
    expect([leaf.partyId, leaf.amount]).toEqual([PA, out.allocations.find((a) => a.partyId === PA)!.amount]);
    expect(await verifyClaimLeafProof(SHA256_RFC9162_HASHER, unhex(leaf.leafBytes), { leafIndex: leaf.leafIndex, treeSize: 1, leafHash: leaf.leafHash, path: leaf.path, root: out.merkleRoot }, { root: out.merkleRoot, treeSize: 1 })).toBe(true);
    expect(out.carry.ledgerIn.sha256).toBe(await carryLedgerHash(EMPTY_CARRY_LEDGER));
  });

  it("carries forward: deferred dust goes out, and the next cycle takes it in and pays it", async () => {
    // A dust threshold above party A's share defers it: its amount is carried out, not paid.
    const dusty = { ...DOSSIER, distributionPolicy: { ...DOSSIER.distributionPolicy, dustThreshold: 10n ** 12n } };
    const n = await engine.calculate(await request({ dossier: dusty }));
    expect(n.frozen.leaves).toHaveLength(0);
    const out = await parseCarryLedger(n.carry.ledgerOut.body, n.carry.ledgerOut.sha256);
    expect(out.deferred.map((d) => d.partyId)).toEqual([PA]);
    const carried = out.deferred[0]!.amount;
    expect(carried > 0n).toBe(true);
    // Cycle N+1 (no dust threshold) takes the carry-in: inflow grows by exactly the carried amount, and A's leaf pays it.
    const plain = await engine.calculate(await request({ cycle: await cycle({ id: "00000000-0000-4000-8000-0000000000c2" }) }));
    const next = await engine.calculate(await request({ cycle: await cycle({ id: "00000000-0000-4000-8000-0000000000c2" }), carryIn: { sourceSetId: "00000000-0000-4000-8000-0000000000d1", ledger: out, sha256: n.carry.ledgerOut.sha256 } }));
    expect(BigInt(next.totals.inflow!) - BigInt(plain.totals.inflow!)).toBe(carried);
    expect(next.carry.ledgerIn.sha256).toBe(n.carry.ledgerOut.sha256);
    const a = next.allocations.find((x) => x.partyId === PA)!;
    expect(a.amount - plain.allocations.find((x) => x.partyId === PA)!.amount).toBe(carried);
    expect(next.frozen.leaves.find((l) => l.partyId === PA)!.amount).toBe(a.amount);
    expect(next.allocations.reduce((t, x) => t + x.amount, 0n).toString()).toBe(next.totals.inflow);
  });
});
