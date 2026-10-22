/**
 * Zero-allocation policy (option B, approved 2026-10-22): a payable entry never has amount 0. A party whose
 * amount is 0 is deferred with `deferredReason: "zero_amount"`, whatever the dust threshold; nothing is
 * carried for it, so conservation is unaffected. Non-zero amounts behave exactly as before.
 *
 * To regenerate the C# sample after a deliberate change: write `await tinyHoldersSampleText()` to
 * clients/unity-starter/Samples/claim-payloads.tiny-holders.sample.json.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { yieldArtifactHash } from "./artifact";
import { SHA256_RFC9162_HASHER, decodeClaimLeaf, encodeClaimLeaf, verifyClaimLeafProof } from "./claim-tree";
import { type ClaimPayloadDto, type PublishedClaimTree, createClaimLookup, verifyClaimPayload } from "./claim-lookup";
import { type DistributionShare, SIMULATION_DISTRIBUTION_POLICY, distributionPlanProblems, emptyDistributionLedger, partyEntryState, planDistribution } from "./distribution";
import { cycleArtifactProblems } from "./pipeline";
import { unhex } from "./pipeline.scenario.test-support";
import { tinyHoldersCycle, tinyHoldersSampleText } from "./zero-allocation.sample.test-support";

const SAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../clients/unity-starter/Samples/claim-payloads.tiny-holders.sample.json");
const cycle = { id: "00000000-0000-4000-8000-00000000000a", version: 1, simulation: true };
const party = (partyId: string, weight: bigint, payoutWallet: string | null = `${partyId.padStart(2, "0").slice(-2)}`.repeat(32)): DistributionShare => ({ kind: "party", partyId, payoutWallet, weight });
const plan = (shares: DistributionShare[], ndy: bigint, dustThreshold = 0n, ledger = emptyDistributionLedger()) =>
  planDistribution({ cycle, policy: { ...SIMULATION_DISTRIBUTION_POLICY, dustThreshold }, netDistributableYield: ndy, shares, ledger });
const view = (p: ReturnType<typeof plan>) => p.entries.map((e) => [e.partyId ?? e.holderKey, e.amount, e.state, e.deferredReason]);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("the state rule", () => {
  it("defers a zero amount whatever the threshold, with zero_amount taking precedence over the dust threshold", () => {
    expect(partyEntryState("w", 0n, 0n)).toEqual({ state: "deferred", deferredReason: "zero_amount" });
    expect(partyEntryState("w", 0n, 5n)).toEqual({ state: "deferred", deferredReason: "zero_amount" });
    expect(partyEntryState("w", 3n, 5n)).toEqual({ state: "deferred", deferredReason: "below_dust_threshold" });
    expect(partyEntryState("w", 5n, 5n)).toEqual({ state: "payable", deferredReason: null });
    expect(partyEntryState("w", 1n, 0n)).toEqual({ state: "payable", deferredReason: null });
    expect(partyEntryState(null, 0n, 0n)).toEqual({ state: "withheld", deferredReason: null });
  });
});

describe("planDistribution with tiny holders", () => {
  it("defers parties whose allocation rounds to 0, carries nothing for them, and conserves exactly", () => {
    // 10 units over weights 1,000,000 : 1 : 1 → the two tiny holders round down to 0.
    const p = plan([party("aa", 1_000_000n), party("bb", 1n), party("cc", 1n)], 10n);
    expect(view(p)).toEqual([
      ["aa", 10n, "payable", null],
      ["bb", 0n, "deferred", "zero_amount"],
      ["cc", 0n, "deferred", "zero_amount"],
    ]);
    expect(p.totals).toEqual({ payable: 10n, deferred: 0n, withheld: 0n, unattributed: 0n, remainderCarried: 0n });
    expect(p.ledgerOut.deferred).toEqual([]);
    expect(distributionPlanProblems(p)).toEqual([]);
  });

  it("a zero allocation with dust carried in is paid when the total reaches the threshold (0 here)", () => {
    const p = plan([party("aa", 1_000_000n), party("bb", 1n)], 10n, 0n, { carriedRemainder: 0n, deferred: [{ partyId: "bb", amount: 7n }] });
    expect(view(p)).toEqual([
      ["aa", 10n, "payable", null],
      ["bb", 7n, "payable", null],
    ]);
  });

  it("leaves non-zero allocations unchanged: the same states as before, payable with no reason", () => {
    // Every allocation non-zero: below the threshold is dust exactly as before; reasons only label it.
    const shares = [party("aa", 50n), party("bb", 30n), party("cc", 15n, null), party("dd", 4n), party("ee", 1n)];
    const p = plan(shares, 1_000n, 45n);
    expect(view(p)).toEqual([
      ["aa", 500n, "payable", null],
      ["bb", 300n, "payable", null],
      ["cc", 150n, "withheld", null],
      ["dd", 40n, "deferred", "below_dust_threshold"],
      ["ee", 10n, "deferred", "below_dust_threshold"],
    ]);
    expect(p.ledgerOut.deferred).toEqual([
      { partyId: "dd", amount: 40n },
      { partyId: "ee", amount: 10n },
    ]);
  });

  it("detects a plan whose states or reasons do not follow the rule", () => {
    const p = plan([party("aa", 1_000_000n), party("bb", 1n)], 10n);
    const payableZero = structuredClone(p);
    Object.assign(payableZero.entries[1]!, { state: "payable", deferredReason: null });
    expect(distributionPlanProblems(payableZero)).toEqual(["entry bb: state payable/null should be deferred/zero_amount", "entry bb: a payable entry has amount 0"]);
    const relabelled = structuredClone(p);
    relabelled.entries[1]!.deferredReason = "below_dust_threshold";
    expect(distributionPlanProblems(relabelled)).toEqual(["entry bb: state deferred/below_dust_threshold should be deferred/zero_amount"]);
  });
});

describe("pipeline cycle with tiny holders (dust threshold 0)", () => {
  it("completes: zero amounts are deferred, never leaves; every proof verifies; conservation holds", async () => {
    const { artifact, artifactSha256, state } = await tinyHoldersCycle();
    expect(state).toBe("calculated");
    const entries = artifact.distribution.plan.entries;
    const zeros = entries.filter((e) => e.deferredReason === "zero_amount");
    expect(zeros.length).toBeGreaterThan(5);
    const tree = artifact.claimTree!;
    const inTree = new Set(tree.leaves.map((l) => l.partyId));
    expect(zeros.some((e) => inTree.has(e.partyId!))).toBe(false);
    expect(tree.leaves.every((l) => l.amount > 0n)).toBe(true);
    expect(tree.leaves.length).toBe(entries.filter((e) => e.state === "payable").length);
    for (const l of tree.leaves) expect(await verifyClaimLeafProof(SHA256_RFC9162_HASHER, unhex(l.leafBytes), l.proof, { root: tree.root, treeSize: tree.size })).toBe(true);
    const t = artifact.totals;
    expect(t.leaves + t.dustCarriedForward + t.withheld + t.unattributed + t.remainderCarried).toBe(t.inflow);
    expect(await cycleArtifactProblems(artifact, artifactSha256, SHA256_RFC9162_HASHER)).toEqual([]);
    // Holders can see why they have no claim.
    const lookup = await createClaimLookup(artifact, artifactSha256, SHA256_RFC9162_HASHER);
    expect(lookup.byPartyId(zeros[0]!.partyId!)).toEqual({ status: "no_leaf", reason: "deferred", deferredReason: "zero_amount" });
  });

  it("is stable: the same seed and inputs give the same leaves, proofs, root and artifact hash", async () => {
    const a = await tinyHoldersCycle();
    const b = await tinyHoldersCycle();
    expect(b.artifactSha256).toBe(a.artifactSha256);
    expect(b.artifact.claimTree!.root).toBe(a.artifact.claimTree!.root);
    expect(b.artifact.claimTree!.leaves.map((l) => [l.leafBytes, l.leafHash, l.proof.path])).toEqual(a.artifact.claimTree!.leaves.map((l) => [l.leafBytes, l.leafHash, l.proof.path]));
  });

  it("refuses an artifact in which a zero entry was made payable, even with its hash recomputed", async () => {
    const { artifact } = await tinyHoldersCycle();
    const forged = structuredClone(artifact);
    const i = forged.distribution.plan.entries.findIndex((e) => e.deferredReason === "zero_amount");
    Object.assign(forged.distribution.plan.entries[i]!, { state: "payable", deferredReason: null });
    const problems = await cycleArtifactProblems(forged, await yieldArtifactHash(forged), SHA256_RFC9162_HASHER);
    expect(problems.some((p) => p.includes("a payable entry has amount 0"))).toBe(true);
  });

  it("zero-amount leaves are refused on decode and in claim payloads", async () => {
    const { artifact, artifactSha256 } = await tinyHoldersCycle();
    const lookup = await createClaimLookup(artifact, artifactSha256, SHA256_RFC9162_HASHER);
    const c = lookup.all()[0]!;
    const fields = await decodeClaimLeaf(unhex(c.leafBytes));
    const zeroBytes = unhex(c.leafBytes);
    zeroBytes.fill(0, 185, 193);
    await expect(decodeClaimLeaf(zeroBytes)).rejects.toThrow(/greater than zero/);
    await expect(encodeClaimLeaf({ ...fields, amount: 0n })).rejects.toThrow();
    expect(await verifyClaimPayload({ ...c, amount: "0", leafBytes: hex(zeroBytes) }, lookup.published!, SHA256_RFC9162_HASHER)).toBe(false);
  });
});

describe("tiny-holders sample shared with C#", () => {
  it("the committed file is exactly what the live pipeline produces", async () => {
    expect(readFileSync(SAMPLE, "utf8")).toBe(await tinyHoldersSampleText());
  });

  it("every claim in it verifies, and no claim is for 0", async () => {
    const s = JSON.parse(readFileSync(SAMPLE, "utf8")) as { publishedTree: PublishedClaimTree; claims: ClaimPayloadDto[] };
    expect(s.claims.length).toBeGreaterThan(10);
    for (const c of s.claims) {
      expect(c.amount).not.toBe("0");
      expect(await verifyClaimPayload(c, s.publishedTree, SHA256_RFC9162_HASHER)).toBe(true);
    }
  });
});
