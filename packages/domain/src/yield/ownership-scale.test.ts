/**
 * Scale and stress: the simulation cycle pipeline (PR #73) with snapshot-bound leaves (layout 2, PR #75) over
 * synthetic ownership datasets of 1,000+ holders. Each run is checked independently of the pipeline:
 * - every RFC 9162 proof verifies against the published root and size, and every leaf decodes to its
 *   entry (index, recipient, amount, snapshot hash);
 * - the root is recomputed with the separate twin Merkle implementation;
 * - every allocation is floor(S × shares / total) or one more, the extra units go to the largest
 *   remainders, and Σ allocations = S exactly (largest remainder, all bigint);
 * - conservation: inflow = leaves + dust + withheld + unattributed + remainder.
 */
import { describe, expect, it } from "vitest";
import { merkleLeaf, merkleRoot } from "../twin/commitments";
import { U64_MAX } from "./amounts";
import { SHA256_RFC9162_HASHER, decodeClaimLeaf, verifyClaimLeafProof } from "./claim-tree";
import { SIMULATION_DISTRIBUTION_POLICY } from "./distribution";
import { MockOwnershipAdapter, type MockOwnershipAdapterConfig, type OwnershipSnapshotRequest, loadVerifiedOwnershipSnapshot } from "./ownership-source";
import { type VerifiedOwnershipSnapshot, verifyAndNormalizeSnapshot } from "./ownership-snapshot";
import { type CycleDistributionArtifact, calculateSimulationCycle, cycleArtifactProblems } from "./pipeline";
import { input, unhex } from "./pipeline.scenario.test-support";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (b: Uint8Array) => hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(b))));

const SCALE_REQUEST: OwnershipSnapshotRequest = { assetId: "bb".repeat(32), networkId: "simulation", reference: { kind: "slot", value: 250_000_000n }, verifiedAt: "2026-10-01T09:00:00Z" };
const config = (patch: Partial<MockOwnershipAdapterConfig>): MockOwnershipAdapterConfig => ({ seed: 0x5eedn, holders: 1_024, profile: "uniform", withheldEvery: 0, unattributed: 0, observedAt: "2026-09-30T23:59:59Z", ...patch });
const snapshotOf = (patch: Partial<MockOwnershipAdapterConfig>) => loadVerifiedOwnershipSnapshot(new MockOwnershipAdapter(config(patch)), SCALE_REQUEST);

/** Runs the pipeline over a snapshot; `rateNum` scales the settlement amount (1 → 5,355,000,000 base units). */
async function run(ownership: VerifiedOwnershipSnapshot, opts: { dustThreshold?: bigint; rateNum?: bigint } = {}) {
  const base = await input();
  return calculateSimulationCycle({
    ...base,
    ownership,
    settlement: { ...base.settlement, rate: { ...base.settlement.rate, num: opts.rateNum ?? 1n } },
    distributionPolicy: { ...SIMULATION_DISTRIBUTION_POLICY, dustThreshold: opts.dustThreshold ?? 0n, missingPayoutWallet: "withhold" },
  });
}

/** Checks a run independently of the pipeline's own verification. */
async function checkIndependently(a: CycleDistributionArtifact, artifactSha256: string, s: VerifiedOwnershipSnapshot) {
  const S = a.calculation.settlementAmount;
  const total = s.totalRawShares;
  const plan = a.distribution.plan;
  const holders = [...s.entries.map((e) => ({ id: e.partyId, raw: e.rawShares })), ...s.unattributed.map((u) => ({ id: u.holderKey, raw: u.rawShares }))];
  expect(plan.entries.length).toBe(holders.length);

  // Largest remainder, exactly: floor or floor + 1, extra units to the largest remainders, Σ = S.
  let sum = 0n;
  let minWithExtra: bigint | null = null;
  let maxWithout: bigint | null = null;
  plan.entries.forEach((entry, i) => {
    const h = holders[i]!;
    expect(entry.partyId ?? entry.holderKey).toBe(h.id);
    expect(entry.weight).toBe(h.raw);
    const floor = (S * h.raw) / total;
    const rem = (S * h.raw) % total;
    expect(entry.allocated === floor || entry.allocated === floor + 1n).toBe(true);
    if (entry.allocated === floor + 1n) minWithExtra = minWithExtra === null || rem < minWithExtra ? rem : minWithExtra;
    else maxWithout = maxWithout === null || rem > maxWithout ? rem : maxWithout;
    sum += entry.allocated;
  });
  expect(sum).toBe(S);
  if (minWithExtra !== null && maxWithout !== null) expect(minWithExtra >= maxWithout).toBe(true);

  // Conservation.
  const t = a.totals;
  expect(t.inflow).toBe(S);
  expect(t.leaves + t.dustCarriedForward + t.withheld + t.unattributed + t.remainderCarried).toBe(t.inflow);
  expect(t.remainderCarried).toBe(0n);

  // Every leaf: decodes to its entry, binds the snapshot, and its proof verifies against the published tree.
  const tree = a.claimTree!;
  const payable = plan.entries.filter((e) => e.state === "payable");
  expect(tree.size).toBe(payable.length);
  expect(tree.leaves.length).toBe(payable.length);
  const byParty = new Map(s.entries.map((e) => [e.partyId, e]));
  const twinLeaves: string[] = [];
  for (const l of tree.leaves) {
    const bytes = unhex(l.leafBytes);
    expect(bytes.length).toBe(233);
    const f = await decodeClaimLeaf(bytes);
    expect(f.leafIndex).toBe(l.leafIndex);
    expect(f.amount).toBe(l.amount);
    expect(f.amount <= U64_MAX).toBe(true);
    expect(hex(f.recipient)).toBe(byParty.get(l.partyId)!.recipient);
    expect(hex(f.ownershipSnapshotHash!)).toBe(s.snapshotHash);
    expect(await verifyClaimLeafProof(SHA256_RFC9162_HASHER, bytes, l.proof, { root: tree.root, treeSize: tree.size })).toBe(true);
    const twinLeaf = await merkleLeaf(await sha(bytes));
    expect(twinLeaf).toBe(l.leafHash);
    twinLeaves[l.leafIndex] = twinLeaf;
  }
  expect(tree.leaves.reduce((n, l) => n + l.amount, 0n)).toBe(t.leaves);
  // The root, recomputed with the separate twin RFC 9162 implementation.
  expect(await merkleRoot(twinLeaves)).toBe(tree.root);
  // And the frozen artifact re-verifies as a whole.
  expect(await cycleArtifactProblems(a, artifactSha256, SHA256_RFC9162_HASHER)).toEqual([]);
}

describe("pipeline at scale over synthetic ownership (simulation only)", () => {
  it("1,024 holders (power of two), uniform shares: every proof verifies and allocation is exact", async () => {
    const s = await snapshotOf({ holders: 1_024 });
    const { artifact, artifactSha256, state } = await run(s);
    expect(state).toBe("calculated");
    expect(artifact.claimTree!.size).toBe(1_024);
    await checkIndependently(artifact, artifactSha256, s);
  }, 120_000);

  it("1,537 holders (odd size) with withheld, unattributed and dust entries", async () => {
    const s = await snapshotOf({ holders: 1_537, seed: 0xabcdefn, withheldEvery: 10, unattributed: 25, profile: "uniform" });
    const { artifact, artifactSha256 } = await run(s, { dustThreshold: 1_000_000n });
    const states = new Set(artifact.distribution.plan.entries.map((e) => e.state));
    expect([...states].sort()).toEqual(["deferred", "payable", "unattributed", "withheld"]);
    expect(artifact.distribution.plan.entries.filter((e) => e.state === "withheld").length).toBe(153);
    expect(artifact.claimTree!.size).toBeGreaterThan(1_000);
    await checkIndependently(artifact, artifactSha256, s);
  }, 120_000);

  it("extreme u64 shares: the total exceeds u64 by far, with no precision loss", async () => {
    const s = await snapshotOf({ holders: 1_200, seed: 0xfeedn, profile: "extreme" });
    expect(s.totalRawShares > U64_MAX * 100n).toBe(true);
    expect(s.diagnostics.maxRawShares).toBe(U64_MAX);
    expect(s.diagnostics.minRawShares).toBe(1n);
    // A settlement amount near 5.4 × 10^15 base units, so products reach ~10^38 before division.
    // Holders of 1 unit are allocated 0; a dust threshold of 1 defers them (see the zero-allocation test).
    const { artifact, artifactSha256 } = await run(s, { rateNum: 1_000_000n, dustThreshold: 1n });
    expect(artifact.calculation.settlementAmount).toBe(5_355_000_000_000_000n);
    await checkIndependently(artifact, artifactSha256, s);
  }, 120_000);

  it("4,096 holders: no stack or size limits hit; the same seed gives the same root and artifact hash", async () => {
    const s = await snapshotOf({ holders: 4_096, seed: 42n });
    const one = await run(s);
    await checkIndependently(one.artifact, one.artifactSha256, s);
    const again = await run(await snapshotOf({ holders: 4_096, seed: 42n }));
    expect(again.artifactSha256).toBe(one.artifactSha256);
    expect(again.artifact.claimTree!.root).toBe(one.artifact.claimTree!.root);
    const other = await run(await snapshotOf({ holders: 4_096, seed: 43n }));
    expect(other.artifact.claimTree!.root).not.toBe(one.artifact.claimTree!.root);
  }, 300_000);

  it("skewed shares (1 … 2^48 units) over 2,048 holders: most are dust, the rest verify", async () => {
    const s = await snapshotOf({ holders: 2_048, seed: 7n, profile: "skewed" });
    const { artifact, artifactSha256 } = await run(s, { dustThreshold: 1n });
    expect(artifact.distribution.plan.entries.some((e) => e.state === "deferred")).toBe(true);
    await checkIndependently(artifact, artifactSha256, s);
  }, 120_000);

  it("fails closed on a zero allocation when no dust threshold is set (the simulation default, pending D-9)", async () => {
    const s = await snapshotOf({ holders: 1_200, seed: 0xfeedn, profile: "extreme" });
    // A 1-unit holder's floor allocation is 0: with dustThreshold 0 it is a payable entry, and the claim tree
    // refuses zero-amount leaves, so the whole calculation is refused rather than publishing a 0 claim.
    await expect(run(s, { rateNum: 1_000_000n })).rejects.toThrow(/0 < amount/);
  }, 120_000);

  it("a one-unit change to one holder among 1,024 changes the snapshot hash, every leaf and the root", async () => {
    const adapter = new MockOwnershipAdapter(config({}));
    const baseInput = adapter.inputFor(SCALE_REQUEST);
    const bumped = { ...baseInput, entries: baseInput.entries.map((e, i) => (i === 511 ? { ...e, rawShares: e.rawShares + 1n } : e)) };
    const [a, b] = await Promise.all([verifyAndNormalizeSnapshot(baseInput, { verifiedAt: SCALE_REQUEST.verifiedAt }), verifyAndNormalizeSnapshot(bumped, { verifiedAt: SCALE_REQUEST.verifiedAt })]);
    expect(a.snapshotHash).not.toBe(b.snapshotHash);
    const [ra, rb] = [await run(a), await run(b)];
    expect(ra.artifact.claimTree!.root).not.toBe(rb.artifact.claimTree!.root);
    const hashesA = new Set(ra.artifact.claimTree!.leaves.map((l) => l.leafHash));
    expect(rb.artifact.claimTree!.leaves.some((l) => hashesA.has(l.leafHash))).toBe(false);
  }, 120_000);
});
