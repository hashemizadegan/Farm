/**
 * End-to-end **simulation** cycle pipeline: one pure function from a locked cycle to a frozen cycle
 * distribution artifact, and the review gate that re-verifies it. No database, no network, no signing.
 *
 *   inputs_locked ──calculate──► calculated ──submit──► under_review        (Y1 state machine, §2.1)
 *
 * `calculateSimulationCycle` (the `calculate` transition):
 * 1. refuses anything but a simulation cycle in `inputs_locked` (Y1 transition table);
 * 2. checks the evidence ledger (Y4) is valid and committed for this cycle version, and takes its manifest
 *    commitment;
 * 3. aggregates the evidence lines, converting foreign-currency lines at their recorded rates, and runs the
 *    waterfall (Track 2, Y2); converts the net distributable yield once into settlement base units and
 *    builds the hashed calculation artifact (Y2);
 * 4. re-verifies the **verified ownership snapshot** (its hash over its content, totals, simulation
 *    network), requires its asset to be the leaves' economic asset, and plans the distribution from its raw
 *    u64 shares (Track 1, #64): payable, deferred dust, withheld, unattributed, carried remainder;
 * 5. builds snapshot-bound leaves (layout 2: the §6.2 leaf plus the snapshot hash), the RFC 9162 root and
 *    every proof (#70), then **verifies every proof against the published root and size**
 *    (`verifyClaimLeafProof`) and that every leaf carries the snapshot hash; any failure refuses the
 *    transition;
 * 6. checks conservation and returns a deeply frozen artifact with its SHA-256.
 *
 * `submitSimulationCycleForReview` (the `submit` transition) re-verifies the frozen artifact (hash, every
 * proof, conservation) and refuses the transition if anything fails. The plan's state machine has no
 * separate "committed" state: the artifact set is frozen at `calculate` (§2.2), and `submit` hands it to
 * review.
 *
 * Fail-closed: a non-simulation cycle is refused before anything runs, and every record involved must be
 * usable for the cycle (simulation records for simulation cycles), as each component already enforces.
 * The snapshot is verified as data (`ownership-snapshot.ts`); reading ownership from a chain (Y0, Y5) is not
 * built.
 */
import { type ConversionResult, type RationalRate, convertAmount } from "./fx";
import { type EvidenceLine, aggregateAndCalculate } from "./aggregation";
import { assertExactKeys } from "./amounts";
import { buildCalculationArtifact, yieldArtifactHash } from "./artifact";
import { CLAIM_LEAF_LAYOUT_VERSION_SNAPSHOT_BOUND, type ClaimLeafContext, type ClaimProof, type ClaimTreeHasher, type ClaimTreePolicy, buildClaimTree, decodeClaimLeaf, decodeKey32, verifyClaimLeafProof } from "./claim-tree";
import { type YieldCycleState, yieldTransitionTarget } from "./cycle";
import { type DistributionLedger, type DistributionPlan, type DistributionPolicy, type DistributionShare, distributionPlanHash, planDistribution } from "./distribution";
import { buildEvidenceManifest, evidenceManifestHash } from "./evidence";
import { type EvidenceLedger, assertEvidenceLedger, evidenceItemsFor } from "./evidence-store";
import { type VerifiedOwnershipSnapshot, ownershipSnapshotProblems } from "./ownership-snapshot";
import type { YieldCalculationPolicy } from "./policy";

export const CYCLE_ARTIFACT_SCHEME = "metafarm-yield-cycle-artifact/1";

export type CyclePipelineErrorCode = "simulation_only" | "evidence_not_committed" | "evidence_mismatch" | "ownership_invalid" | "ownership_mismatch" | "ownership_unbound" | "proof_failed" | "conservation" | "artifact_mismatch";

export class CyclePipelineError extends Error {
  constructor(
    readonly code: CyclePipelineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CyclePipelineError";
  }
}

export interface SimulationCycleInput {
  cycle: { id: string; version: number; simulation: boolean; assetClass: string };
  state: YieldCycleState;
  evidenceLedger: EvidenceLedger;
  evidenceLines: EvidenceLine[];
  lossCarriedForward: bigint;
  approvedReserveReleases: bigint;
  calculationPolicy: YieldCalculationPolicy;
  /** The single conversion of the accounting result into settlement base units (D-3, D-4). */
  settlement: { mint: string; network: string; decimals: number; rate: RationalRate };
  /** From `verifyAndNormalizeSnapshot`; re-checked here. */
  ownership: VerifiedOwnershipSnapshot;
  distributionPolicy: DistributionPolicy;
  distributionLedger: DistributionLedger;
  claimTreePolicy: ClaimTreePolicy;
  hasher: ClaimTreeHasher;
  /** The leaves' context; the payout mint comes from `settlement`, the snapshot hash from `ownership`. */
  leafContext: Omit<ClaimLeafContext, "payoutMint" | "ownershipSnapshotHash">;
}

export interface CycleArtifactLeaf {
  leafIndex: number;
  partyId: string;
  /** Hex of the 32 recipient bytes. */
  recipient: string;
  amount: bigint;
  leafBytes: string;
  leafHash: string;
  proof: ClaimProof;
}

export interface CycleDistributionArtifact {
  scheme: typeof CYCLE_ARTIFACT_SCHEME;
  cycle: { id: string; version: number; simulation: boolean; assetClass: string };
  evidence: { manifestSha256: string; itemCount: number };
  /** The full verified snapshot the distribution used; every leaf carries its hash. */
  ownership: VerifiedOwnershipSnapshot;
  calculation: {
    artifactSha256: string;
    /** Accounting minor units. */
    netDistributableYield: bigint;
    loss: bigint;
    shortfall: bigint;
    /** The NDY in settlement base units, with the fraction dropped by the conversion. */
    settlementAmount: bigint;
    conversion: ConversionResult;
  };
  distribution: { planSha256: string; plan: DistributionPlan };
  /** Null when nothing is payable (e.g. a zero or loss cycle). */
  claimTree: { hasherId: string; policyId: string; root: string; size: number; leaves: CycleArtifactLeaf[] } | null;
  /** Settlement base units. inflow = settlementAmount + carried remainder + carried dust. */
  totals: { inflow: bigint; leaves: bigint; dustCarriedForward: bigint; withheld: bigint; unattributed: bigint; remainderCarried: bigint };
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

/** Conservation over the artifact: leaves + carried dust + withheld + unattributed + carried remainder = inflow. */
function conservationProblem(a: CycleDistributionArtifact): string | null {
  const t = a.totals;
  const plan = a.distribution.plan;
  const inflow = a.calculation.settlementAmount + plan.ledgerIn.carriedRemainder + plan.ledgerIn.deferred.reduce((n, d) => n + d.amount, 0n);
  if (t.inflow !== inflow) return `inflow ${t.inflow} is not settlement amount plus carried amounts (${inflow})`;
  const leaves = (a.claimTree?.leaves ?? []).reduce((n, l) => n + l.amount, 0n);
  if (t.leaves !== leaves || leaves !== plan.totals.payable) return `leaf total ${leaves} does not match the recorded ${t.leaves} or the plan's payable ${plan.totals.payable}`;
  if (t.leaves + t.dustCarriedForward + t.withheld + t.unattributed + t.remainderCarried !== t.inflow) return "leaves + carried dust + withheld + unattributed + carried remainder does not equal the inflow";
  return null;
}

/** Every leaf decodes to its recorded amount and index and verifies against the published root and size. */
async function proofProblem(a: CycleDistributionArtifact, hasher: ClaimTreeHasher): Promise<string | null> {
  const tree = a.claimTree;
  if (!tree) return a.distribution.plan.totals.payable === 0n ? null : "payable amounts but no claim tree";
  if (hasher.id !== tree.hasherId) return `the tree was built with ${tree.hasherId}, not ${hasher.id}`;
  if (tree.leaves.length !== tree.size) return "the leaf count does not match the tree size";
  for (const [i, l] of tree.leaves.entries()) {
    if (l.leafIndex !== i) return `leaf ${i} records index ${l.leafIndex}`;
    const bytes = unhex(l.leafBytes);
    let decoded;
    try {
      decoded = await decodeClaimLeaf(bytes);
    } catch {
      return `leaf ${i} does not decode`;
    }
    if (decoded.amount !== l.amount) return `leaf ${i} encodes ${decoded.amount}, not the recorded ${l.amount}`;
    const bound = decoded.ownershipSnapshotHash ? [...decoded.ownershipSnapshotHash].map((b) => b.toString(16).padStart(2, "0")).join("") : null;
    if (bound !== a.ownership.snapshotHash) return `leaf ${i} is not bound to the ownership snapshot ${a.ownership.snapshotHash}`;
    if (!(await verifyClaimLeafProof(hasher, bytes, l.proof, { root: tree.root, treeSize: tree.size }))) return `the proof of leaf ${i} does not verify against the published root`;
  }
  return null;
}

/** The snapshot verifies, and the distribution plan's shares are exactly the snapshot's. */
async function ownershipProblem(a: CycleDistributionArtifact): Promise<string | null> {
  const problems = await ownershipSnapshotProblems(a.ownership);
  if (problems.length) return `ownership snapshot: ${problems.join("; ")}`;
  const want = sharesOf(a.ownership).map((x) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const plan = a.distribution.plan.entries.map((e) =>
    JSON.stringify(e.kind === "party" ? { kind: "party", partyId: e.partyId, recipient: recipientHex(e.payoutWallet), weight: e.weight } : { kind: "unattributed", holderKey: e.holderKey, weight: e.weight }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
  const norm = (xs: string[]) => [...xs].sort().join("\n");
  if (norm(want) !== norm(plan)) return "the distribution plan's shares are not the ownership snapshot's";
  return null;
}

const recipientHex = (address: string | null) => {
  if (address === null) return null;
  try {
    return [...decodeKey32("payout address", address)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "invalid";
  }
};

/** The snapshot's shares in the comparison form used by `ownershipProblem`. */
function sharesOf(s: VerifiedOwnershipSnapshot) {
  return [
    ...s.entries.map((e) => ({ kind: "party", partyId: e.partyId, recipient: e.recipient, weight: e.rawShares })),
    ...s.unattributed.map((u) => ({ kind: "unattributed", holderKey: u.holderKey, weight: u.rawShares })),
  ];
}

/** The distribution shares of a verified snapshot. */
function distributionSharesOf(s: VerifiedOwnershipSnapshot): DistributionShare[] {
  return [
    ...s.entries.map((e) => ({ kind: "party" as const, partyId: e.partyId, payoutWallet: e.payoutAddress, weight: e.rawShares })),
    ...s.unattributed.map((u) => ({ kind: "unattributed" as const, holderKey: u.holderKey, weight: u.rawShares })),
  ];
}

/** The `calculate` transition for a simulation cycle. Returns the new state and the frozen artifact. */
export async function calculateSimulationCycle(input: SimulationCycleInput): Promise<{ state: YieldCycleState; artifact: CycleDistributionArtifact; artifactSha256: string }> {
  assertExactKeys("pipeline input", input, [
    "cycle",
    "state",
    "evidenceLedger",
    "evidenceLines",
    "lossCarriedForward",
    "approvedReserveReleases",
    "calculationPolicy",
    "settlement",
    "ownership",
    "distributionPolicy",
    "distributionLedger",
    "claimTreePolicy",
    "hasher",
    "leafContext",
  ]);
  const { cycle } = input;
  assertExactKeys("cycle", cycle as unknown, ["id", "version", "simulation", "assetClass"]);
  // 1. Simulation only; the Y1 table decides whether `calculate` is allowed from this state.
  if (cycle.simulation !== true) throw new CyclePipelineError("simulation_only", "the cycle pipeline runs simulation cycles only");
  const next = yieldTransitionTarget(input.state, "calculate", { simulation: true });
  const id = { id: cycle.id, version: cycle.version, simulation: true };

  // 2. Evidence: a valid ledger, committed for this cycle version.
  await assertEvidenceLedger(input.evidenceLedger);
  const commit = input.evidenceLedger.entries.find((e) => e.kind === "committed" && e.cycleId === cycle.id && e.cycleVersion === cycle.version);
  if (!commit || commit.kind !== "committed") throw new CyclePipelineError("evidence_not_committed", `the evidence of cycle ${cycle.id} version ${cycle.version} is not committed`);
  const manifest = buildEvidenceManifest({ cycleId: cycle.id, cycleVersion: cycle.version, items: evidenceItemsFor(input.evidenceLedger, cycle.id, cycle.version) });
  if ((await evidenceManifestHash(manifest)) !== commit.manifestSha256) throw new CyclePipelineError("evidence_mismatch", "the committed manifest hash does not match the registered evidence");

  // 3. Aggregate and calculate; convert once into settlement base units; hash the calculation artifact.
  const calc = aggregateAndCalculate({ cycle: id, policy: input.calculationPolicy, manifest, lines: input.evidenceLines, lossCarriedForward: input.lossCarriedForward, approvedReserveReleases: input.approvedReserveReleases });
  const conversion = convertAmount(calc.result.netDistributableYield, input.calculationPolicy.accountingCurrency.exponent, input.settlement.decimals, input.settlement.rate);
  const calculationArtifact = buildCalculationArtifact({ cycle: id, policy: input.calculationPolicy, inputs: calc.inputs, result: calc.result, settlement: { ...input.settlement, conversion } });
  const calculationSha256 = await yieldArtifactHash(calculationArtifact);

  // 4. The verified ownership snapshot, re-checked, for this asset; then the distribution plan from its shares.
  const snapshot = input.ownership;
  const snapshotProblems = await ownershipSnapshotProblems(snapshot);
  if (snapshotProblems.length) throw new CyclePipelineError("ownership_invalid", `ownership snapshot: ${snapshotProblems.join("; ")}`);
  if (recipientHex(input.leafContext.economicAssetId) !== snapshot.assetId) throw new CyclePipelineError("ownership_mismatch", "the ownership snapshot is for another asset than the leaves' economic asset");
  if (input.claimTreePolicy?.leafLayoutVersion !== CLAIM_LEAF_LAYOUT_VERSION_SNAPSHOT_BOUND) throw new CyclePipelineError("ownership_unbound", "the pipeline builds snapshot-bound leaves only: the claim-tree policy must use leaf layout 2");
  const plan = planDistribution({ cycle: id, policy: input.distributionPolicy, netDistributableYield: conversion.value, shares: distributionSharesOf(snapshot), ledger: input.distributionLedger });

  // 5. Claim tree over the payable entries.
  let claimTree: CycleDistributionArtifact["claimTree"] = null;
  if (plan.totals.payable > 0n) {
    const tree = await buildClaimTree({ plan, policy: input.claimTreePolicy, hasher: input.hasher, context: { ...input.leafContext, payoutMint: input.settlement.mint, ownershipSnapshotHash: snapshot.snapshotHash } });
    claimTree = {
      hasherId: tree.hasherId,
      policyId: tree.policy.id,
      root: tree.root,
      size: tree.size,
      leaves: tree.leaves.map((l) => ({ leafIndex: l.leafIndex, partyId: l.partyId, recipient: l.recipient, amount: l.amount, leafBytes: l.leafBytes, leafHash: l.leafHash, proof: l.proof })),
    };
  }

  const t = plan.totals;
  const artifact: CycleDistributionArtifact = {
    scheme: CYCLE_ARTIFACT_SCHEME,
    cycle: { ...cycle },
    evidence: { manifestSha256: commit.manifestSha256, itemCount: commit.itemCount },
    ownership: snapshot,
    calculation: { artifactSha256: calculationSha256, netDistributableYield: calc.result.netDistributableYield, loss: calc.result.loss, shortfall: calc.result.shortfall, settlementAmount: conversion.value, conversion },
    distribution: { planSha256: await distributionPlanHash(plan), plan },
    claimTree,
    totals: {
      inflow: conversion.value + plan.ledgerIn.carriedRemainder + plan.ledgerIn.deferred.reduce((n, d) => n + d.amount, 0n),
      leaves: (claimTree?.leaves ?? []).reduce((n, l) => n + l.amount, 0n),
      dustCarriedForward: t.deferred,
      withheld: t.withheld,
      unattributed: t.unattributed,
      remainderCarried: t.remainderCarried,
    },
  };

  // 6. Verify before the transition completes: every proof, then conservation.
  const proof = await proofProblem(artifact, input.hasher);
  if (proof) throw new CyclePipelineError("proof_failed", `calculate refused: ${proof}`);
  const ownership = await ownershipProblem(artifact);
  if (ownership) throw new CyclePipelineError("ownership_mismatch", `calculate refused: ${ownership}`);
  const conservation = conservationProblem(artifact);
  if (conservation) throw new CyclePipelineError("conservation", `calculate refused: ${conservation}`);

  deepFreeze(artifact);
  return { state: next, artifact, artifactSha256: await yieldArtifactHash(artifact) };
}

/** Re-verifies a frozen artifact: its hash, every proof against the published root and size, and conservation. */
export async function cycleArtifactProblems(artifact: CycleDistributionArtifact, artifactSha256: string, hasher: ClaimTreeHasher): Promise<string[]> {
  const out: string[] = [];
  if (artifact?.scheme !== CYCLE_ARTIFACT_SCHEME) return ["not a cycle distribution artifact"];
  if ((await yieldArtifactHash(artifact)) !== artifactSha256) out.push("the artifact does not hash to the recorded SHA-256");
  const proof = await proofProblem(artifact, hasher);
  if (proof) out.push(proof);
  const ownership = await ownershipProblem(artifact);
  if (ownership) out.push(ownership);
  const conservation = conservationProblem(artifact);
  if (conservation) out.push(conservation);
  return out;
}

/** The `submit` transition (calculated → under_review): refused unless the frozen artifact still verifies. */
export async function submitSimulationCycleForReview(input: { state: YieldCycleState; artifact: CycleDistributionArtifact; artifactSha256: string; hasher: ClaimTreeHasher }): Promise<YieldCycleState> {
  if (input.artifact?.cycle?.simulation !== true) throw new CyclePipelineError("simulation_only", "the cycle pipeline runs simulation cycles only");
  const next = yieldTransitionTarget(input.state, "submit", { simulation: true });
  const problems = await cycleArtifactProblems(input.artifact, input.artifactSha256, input.hasher);
  if (problems.length) throw new CyclePipelineError(problems.some((p) => p.includes("proof") || p.includes("leaf")) ? "proof_failed" : "artifact_mismatch", `submit refused: ${problems.join("; ")}`);
  return next;
}
