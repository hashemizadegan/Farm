import { describe, expect, it } from "vitest";
import { yieldArtifactHash } from "./artifact";
import { type ClaimTreeHasher, SHA256_RFC9162_HASHER, SIMULATION_CLAIM_TREE_POLICY_SNAPSHOT_BOUND, decodeClaimLeaf, verifyClaimLeafProof } from "./claim-tree";
import type { YieldTransitionError } from "./cycle";
import { type DistributionLedger, SIMULATION_DISTRIBUTION_POLICY } from "./distribution";
import { SIMULATION_EVIDENCE_STORAGE_POLICY, emptyEvidenceLedger, registerEvidence } from "./evidence-store";
import { F3_ILLUSTRATION, simulationPolicy } from "./fixtures.test-support";
import { type CycleDistributionArtifact, type CyclePipelineError, calculateSimulationCycle, cycleArtifactProblems, submitSimulationCycleForReview } from "./pipeline";
import { CYCLE, ITEMS, LINES, SNAPSHOT_INPUT, committedLedger, input, ledgerCycle, line, scenarioSnapshot, unhex } from "./pipeline.scenario.test-support";
import { YieldRecordError } from "./records";

const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return (e as CyclePipelineError | YieldTransitionError).code ?? (e as Error).name;
  }
  return "no error";
};
/** A mutable deep copy (bigints kept). */
const copy = <T>(v: T): T => structuredClone(v);

describe("simulation cycle pipeline: multi-party scenario", () => {
  it("runs inputs_locked → calculated and produces the expected numbers", async () => {
    const r = await calculateSimulationCycle(await input());
    expect(r.state).toBe("calculated");
    const a = r.artifact;
    expect(a.calculation.netDistributableYield).toBe(535_500n); // 5,355.00 USD
    expect(a.calculation.settlementAmount).toBe(5_355_000_000n); // × 10^4 at the recorded 1/1 rate
    expect(a.calculation.conversion.droppedNumerator).toBe(0n);
    const states = Object.fromEntries(a.distribution.plan.entries.map((e) => [e.partyId ?? e.holderKey, [e.amount, e.state]]));
    expect(states).toEqual({
      "party-a": [2_677_500_000n, "payable"],
      "party-b": [1_606_500_000n, "payable"],
      "party-c": [803_250_000n, "withheld"],
      "token-account-x": [214_200_000n, "unattributed"],
      "party-d": [53_550_000n, "deferred"],
    });
    expect(a.claimTree!.size).toBe(2);
    expect(a.claimTree!.leaves.map((l) => l.partyId)).toEqual(["party-a", "party-b"]); // recipient byte order: 0x01… < 0x06… (wSOL)
  });

  it("conserves: claim leaves + dust carried + withheld (incl. unattributed) + remainder = net distributable amount", async () => {
    const { artifact: a } = await calculateSimulationCycle(await input());
    const t = a.totals;
    expect(t.leaves).toBe(a.claimTree!.leaves.reduce((n, l) => n + l.amount, 0n));
    expect(t.leaves + t.dustCarriedForward + t.withheld + t.unattributed + t.remainderCarried).toBe(a.calculation.settlementAmount);
    expect(t).toEqual({ inflow: 5_355_000_000n, leaves: 4_284_000_000n, dustCarriedForward: 53_550_000n, withheld: 803_250_000n, unattributed: 214_200_000n, remainderCarried: 0n });
  });

  it("conserves with dust and a remainder carried in from the previous cycle", async () => {
    const ledger: DistributionLedger = { carriedRemainder: 3n, deferred: [{ partyId: "party-d", amount: 7n }, { partyId: "gone", amount: 11n }] };
    const { artifact: a } = await calculateSimulationCycle(await input({ distributionLedger: ledger, distributionPolicy: { ...SIMULATION_DISTRIBUTION_POLICY, dustThreshold: 60_000_000n, missingPayoutWallet: "withhold", remainder: "carry" } }));
    const t = a.totals;
    expect(t.inflow).toBe(5_355_000_000n + 3n + 7n + 11n);
    expect(t.leaves + t.dustCarriedForward + t.withheld + t.unattributed + t.remainderCarried).toBe(t.inflow);
    expect(a.distribution.plan.ledgerOut.deferred.map((d) => d.partyId)).toEqual(["gone", "party-d"]);
  });

  it("publishes proofs that all verify against the published root and size", async () => {
    const { artifact: a } = await calculateSimulationCycle(await input());
    for (const l of a.claimTree!.leaves) expect(await verifyClaimLeafProof(SHA256_RFC9162_HASHER, unhex(l.leafBytes), l.proof, { root: a.claimTree!.root, treeSize: a.claimTree!.size })).toBe(true);
  });

  it("records the committed evidence manifest and is frozen and deterministic", async () => {
    const ledger = await committedLedger();
    const commit = ledger.entries.find((e) => e.kind === "committed")!;
    const r1 = await calculateSimulationCycle(await input({ evidenceLedger: ledger }));
    expect(r1.artifact.evidence).toEqual({ manifestSha256: (commit as { manifestSha256: string }).manifestSha256, itemCount: 5 });
    expect(Object.isFrozen(r1.artifact) && Object.isFrozen(r1.artifact.claimTree!.leaves[0]!.proof.path)).toBe(true);
    expect(() => {
      (r1.artifact.totals as { leaves: bigint }).leaves = 0n;
    }).toThrow(TypeError);
    // Same inputs in another order (lines), and the same snapshot verified again, give the same artifact.
    const r2 = await calculateSimulationCycle(await input({ ownership: await scenarioSnapshot(), evidenceLines: [...LINES].reverse() }));
    expect(r2.artifactSha256).toBe(r1.artifactSha256);
    expect(await yieldArtifactHash(r1.artifact)).toBe(r1.artifactSha256);
  });

  it("handles a zero cycle: no claim tree, nothing distributed, still submittable", async () => {
    const zero = [line("rev", 1, "gross_revenue", 500_000n), line("cost", 4, "operating_expense", 500_000n)];
    const r = await calculateSimulationCycle(await input({ evidenceLines: zero }));
    expect(r.artifact.claimTree).toBeNull();
    expect(r.artifact.totals).toEqual({ inflow: 0n, leaves: 0n, dustCarriedForward: 0n, withheld: 0n, unattributed: 0n, remainderCarried: 0n });
    expect(await submitSimulationCycleForReview({ state: r.state, artifact: r.artifact, artifactSha256: r.artifactSha256, hasher: SHA256_RFC9162_HASHER })).toBe("under_review");
  });
});

describe("review gate: calculated → under_review only if every proof verifies", () => {
  it("submits an intact artifact", async () => {
    const r = await calculateSimulationCycle(await input());
    expect(await cycleArtifactProblems(r.artifact, r.artifactSha256, SHA256_RFC9162_HASHER)).toEqual([]);
    expect(await submitSimulationCycleForReview({ state: "calculated", artifact: r.artifact, artifactSha256: r.artifactSha256, hasher: SHA256_RFC9162_HASHER })).toBe("under_review");
  });

  it("refuses when a leaf proof fails, even if the artifact hash is recomputed to match", async () => {
    const r = await calculateSimulationCycle(await input());
    const tamperings: ((a: CycleDistributionArtifact) => void)[] = [
      (a) => {
        a.claimTree!.leaves[0]!.proof.path[0] = "f".repeat(64);
      },
      (a) => {
        const b = unhex(a.claimTree!.leaves[1]!.leafBytes);
        b[185] = b[185]! ^ 1;
        a.claimTree!.leaves[1]!.leafBytes = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      },
      (a) => {
        a.claimTree!.root = "0".repeat(64);
      },
      (a) => {
        a.claimTree!.leaves[0]!.proof.leafIndex = 1;
      },
    ];
    for (const tamper of tamperings) {
      const t = copy(r.artifact);
      tamper(t);
      const rehashed = await yieldArtifactHash(t);
      expect(await code(() => submitSimulationCycleForReview({ state: "calculated", artifact: t, artifactSha256: rehashed, hasher: SHA256_RFC9162_HASHER }))).toBe("proof_failed");
    }
  });

  it("refuses when amounts no longer conserve or the artifact hash does not match", async () => {
    const r = await calculateSimulationCycle(await input());
    const moved = copy(r.artifact);
    moved.totals.withheld -= 1n;
    moved.totals.dustCarriedForward += 1n;
    expect((await cycleArtifactProblems(moved, await yieldArtifactHash(moved), SHA256_RFC9162_HASHER)).length).toBe(0); // moving value between buckets conserves
    const lost = copy(r.artifact);
    lost.totals.withheld -= 1n;
    expect(await code(() => submitSimulationCycleForReview({ state: "calculated", artifact: lost, artifactSha256: r.artifactSha256, hasher: SHA256_RFC9162_HASHER }))).toBe("artifact_mismatch");
    expect(await cycleArtifactProblems(lost, await yieldArtifactHash(lost), SHA256_RFC9162_HASHER)).toEqual(["leaves + carried dust + withheld + unattributed + carried remainder does not equal the inflow"]);
    const amount = copy(r.artifact);
    amount.claimTree!.leaves[0]!.amount += 1n;
    const amountHash = await yieldArtifactHash(amount);
    expect(await code(() => submitSimulationCycleForReview({ state: "calculated", artifact: amount, artifactSha256: amountHash, hasher: SHA256_RFC9162_HASHER }))).toBe("proof_failed");
  });

  it("refuses submit from any state but calculated, and under another hasher", async () => {
    const r = await calculateSimulationCycle(await input());
    expect(await code(() => submitSimulationCycleForReview({ state: "inputs_locked", artifact: r.artifact, artifactSha256: r.artifactSha256, hasher: SHA256_RFC9162_HASHER }))).toBe("invalid_transition");
    const other: ClaimTreeHasher = { ...SHA256_RFC9162_HASHER, id: "other" };
    expect(await code(() => submitSimulationCycleForReview({ state: "calculated", artifact: r.artifact, artifactSha256: r.artifactSha256, hasher: other }))).toBe("proof_failed");
  });

  it("refuses calculate itself when a proof fails verification (the cycle stays inputs_locked)", async () => {
    // A faulty hasher: correct while the tree is built, wrong when the proofs are checked.
    let calls = 0;
    const faulty: ClaimTreeHasher = {
      id: "test-faulty",
      leaf: async (b) => {
        const out = await SHA256_RFC9162_HASHER.leaf(b);
        if (++calls > 2) out[0] = out[0]! ^ 1;
        return out;
      },
      node: SHA256_RFC9162_HASHER.node,
    };
    expect(await code(async () => calculateSimulationCycle(await input({ hasher: faulty, claimTreePolicy: { ...SIMULATION_CLAIM_TREE_POLICY_SNAPSHOT_BOUND, hasherId: "test-faulty" } })))).toBe("proof_failed");
  });
});

describe("fail-closed", () => {
  it("refuses real cycles before doing anything", async () => {
    expect(await code(async () => calculateSimulationCycle(await input({ cycle: { ...CYCLE, simulation: false } })))).toBe("simulation_only");
    const r = await calculateSimulationCycle(await input());
    const real = copy(r.artifact);
    real.cycle.simulation = false;
    expect(await code(() => submitSimulationCycleForReview({ state: "calculated", artifact: real, artifactSha256: r.artifactSha256, hasher: SHA256_RFC9162_HASHER }))).toBe("simulation_only");
  });

  it("refuses records that are not simulation records", async () => {
    for (const patch of [
      { calculationPolicy: { ...simulationPolicy(F3_ILLUSTRATION), status: "approved" as const } },
      { distributionPolicy: { ...SIMULATION_DISTRIBUTION_POLICY, status: "approved" as const } },
      { claimTreePolicy: { ...SIMULATION_CLAIM_TREE_POLICY_SNAPSHOT_BOUND, status: "draft" as const } },
    ])
      await expect(calculateSimulationCycle(await input(patch))).rejects.toBeInstanceOf(YieldRecordError);
  });

  it("follows the Y1 table: calculate only from inputs_locked", async () => {
    for (const state of ["draft", "calculated", "under_review", "published", "closed"] as const) expect(await code(async () => calculateSimulationCycle(await input({ state }))), state).toBe("invalid_transition");
  });

  it("requires committed, intact evidence for this cycle version", async () => {
    let open = emptyEvidenceLedger();
    for (const i of ITEMS) open = registerEvidence(open, { cycle: ledgerCycle(CYCLE), policy: SIMULATION_EVIDENCE_STORAGE_POLICY, item: i, storageRef: `sha256:${i.contentSha256}` });
    expect(await code(async () => calculateSimulationCycle(await input({ evidenceLedger: open })))).toBe("evidence_not_committed");
    expect(await code(async () => calculateSimulationCycle(await input({ evidenceLedger: await committedLedger({ ...CYCLE, version: 2 }) })))).toBe("evidence_not_committed");
    const good = await committedLedger();
    const forged = { entries: good.entries.map((e) => (e.kind === "committed" ? { ...e, manifestSha256: "0".repeat(64) } : e)) };
    expect(await code(async () => calculateSimulationCycle(await input({ evidenceLedger: forged })))).toBe("ledger_corrupt");
    // A line backed by evidence outside the committed manifest is refused.
    expect(await code(async () => calculateSimulationCycle(await input({ evidenceLines: [...LINES, line("extra", 9, "gross_revenue", 1n)] })))).toBe("unknown_evidence");
  });

  it("refuses unsupported input keys", async () => {
    expect(await code(async () => calculateSimulationCycle({ ...(await input()), mainnet: true } as never))).toBe("invalid_parameter");
  });
});

describe("ownership snapshot binding", () => {
  const hexOf = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

  it("binds every claim leaf, and so the root, to the snapshot hash (leaf layout 2)", async () => {
    const { artifact: a } = await calculateSimulationCycle(await input());
    expect(a.ownership.snapshotHash).toBe((await scenarioSnapshot()).snapshotHash);
    for (const l of a.claimTree!.leaves) {
      expect(l.leafBytes.length).toBe(466); // 233 bytes
      const leaf = await decodeClaimLeaf(unhex(l.leafBytes));
      expect(leaf.leafLayoutVersion).toBe(2);
      expect(hexOf(leaf.ownershipSnapshotHash!)).toBe(a.ownership.snapshotHash);
    }
    // Same shares and addresses under another snapshot id: another snapshot hash, so every leaf and the root differ.
    const other = await calculateSimulationCycle(await input({ ownership: await scenarioSnapshot({ snapshotId: "00000000-0000-4000-8000-0000000000e2" }) }));
    expect(other.artifact.claimTree!.root).not.toBe(a.claimTree!.root);
    other.artifact.claimTree!.leaves.forEach((l, i) => expect(l.leafHash).not.toBe(a.claimTree!.leaves[i]!.leafHash));
  });

  it("fails verification when one raw share unit changes, even if every hash an attacker can recompute is recomputed", async () => {
    const r = await calculateSimulationCycle(await input());
    const t = structuredClone(r.artifact);
    t.ownership.entries[0]!.rawShares += 1n;
    expect(await code(() => submitSimulationCycleForReview({ state: "calculated", artifact: t, artifactSha256: r.artifactSha256, hasher: SHA256_RFC9162_HASHER }))).toBe("artifact_mismatch");
    // Recompute the snapshot (as an attacker could) and the artifact hash: the leaves still name the original snapshot.
    const forged = await scenarioSnapshot({ entries: [{ partyId: "party-a", payoutAddress: "01".repeat(32), rawShares: 51n }, ...SNAPSHOT_INPUT.entries.slice(1)] });
    const t2 = structuredClone(r.artifact);
    t2.ownership = structuredClone(forged);
    const problems = await cycleArtifactProblems(t2, await yieldArtifactHash(t2), SHA256_RFC9162_HASHER);
    expect(problems.some((p) => p.includes("not bound to the ownership snapshot"))).toBe(true);
    expect(problems).toContain("the distribution plan's shares are not the ownership snapshot's");
  });

  it("fails verification when a party's address or the plan's weights no longer match the snapshot", async () => {
    const r = await calculateSimulationCycle(await input());
    const address = structuredClone(r.artifact);
    address.ownership.entries[1]!.payoutAddress = "04".repeat(32);
    expect((await cycleArtifactProblems(address, await yieldArtifactHash(address), SHA256_RFC9162_HASHER)).some((p) => p.startsWith("ownership snapshot:"))).toBe(true);
    const weight = structuredClone(r.artifact);
    weight.distribution.plan.entries[0]!.weight += 1n;
    expect(await cycleArtifactProblems(weight, await yieldArtifactHash(weight), SHA256_RFC9162_HASHER)).toContain("the distribution plan's shares are not the ownership snapshot's");
  });

  it("refuses a tampered snapshot, another asset's snapshot, a real network and unbound (layout 1) leaves", async () => {
    const tampered = structuredClone(await scenarioSnapshot());
    tampered.entries[0]!.rawShares = 49n;
    expect(await code(async () => calculateSimulationCycle(await input({ ownership: tampered })))).toBe("ownership_invalid");
    const real = structuredClone(await scenarioSnapshot()) as unknown as { networkId: string };
    real.networkId = "solana-mainnet";
    expect(await code(async () => calculateSimulationCycle(await input({ ownership: real as never })))).toBe("ownership_invalid");
    expect(await code(async () => calculateSimulationCycle(await input({ ownership: await scenarioSnapshot({ assetId: "bc".repeat(32) }) })))).toBe("ownership_mismatch");
    expect(await code(async () => calculateSimulationCycle(await input({ claimTreePolicy: { ...SIMULATION_CLAIM_TREE_POLICY_SNAPSHOT_BOUND, leafLayoutVersion: 1 } })))).toBe("ownership_unbound");
  });

  it("divides by raw shares exactly, preserving the remainder under the conservation invariant", async () => {
    // Three equal holders of an amount that does not divide by three: the carry rule keeps the remainder.
    const snap = await scenarioSnapshot({
      entries: [
        { partyId: "p1", payoutAddress: "11".repeat(32), rawShares: 7n },
        { partyId: "p2", payoutAddress: "12".repeat(32), rawShares: 7n },
        { partyId: "p3", payoutAddress: "13".repeat(32), rawShares: 7n },
      ],
      unattributed: [],
    });
    const carry = await calculateSimulationCycle(await input({ ownership: snap, distributionPolicy: { ...SIMULATION_DISTRIBUTION_POLICY, remainder: "carry", missingPayoutWallet: "withhold" } }));
    const t = carry.artifact.totals;
    expect(t.inflow).toBe(5_355_000_000n);
    expect(carry.artifact.claimTree!.leaves.map((l) => l.amount)).toEqual([1_785_000_000n, 1_785_000_000n, 1_785_000_000n]);
    expect(t.remainderCarried).toBe(0n); // 5,355,000,000 = 3 × 1,785,000,000 exactly
    const odd = await calculateSimulationCycle(await input({ ownership: await scenarioSnapshot({ unattributed: [{ holderKey: "token-account-x", rawShares: 3n }] }), distributionPolicy: { ...SIMULATION_DISTRIBUTION_POLICY, dustThreshold: 60_000_000n, remainder: "carry", missingPayoutWallet: "withhold" } }));
    const o = odd.artifact.totals;
    // Total raw shares 99: the yield does not divide evenly, and the carried remainder closes the sum exactly.
    expect(odd.artifact.ownership.totalRawShares).toBe(99n);
    expect(o.remainderCarried > 0n).toBe(true);
    expect(o.leaves + o.dustCarriedForward + o.withheld + o.unattributed + o.remainderCarried).toBe(o.inflow);
  });
});
