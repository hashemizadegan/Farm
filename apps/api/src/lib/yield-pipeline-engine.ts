/**
 * The yield calculation engine after the line join (2026-10-22): the yield domain's simulation cycle pipeline
 * (`calculateSimulationCycle`: Y2 waterfall, Y4 evidence ledger, #75 snapshot, #77 distribution, #70 claim tree
 * with snapshot-bound leaves) run over what the database locked, with the cycle's simulation dossier supplying
 * the typed records the database does not hold. Pure and deterministic; no network, no signing.
 *
 * Fail closed, each with a stable code (422 unless noted):
 * - `simulation_only` (409): a real cycle never reaches the pipeline;
 * - `dossier_missing`: no simulation dossier was registered for the cycle;
 * - `real_network_ownership` (409): ownership from a verified RPC source (a real network). The pipeline's snapshot
 *   accepts simulation networks only, and devnet use needs the Y15 devnet approval; this guard is kept, not relaxed;
 * - `dossier_mismatch`: the dossier does not match what the cycle locked (policy hash, entitlement, currency,
 *   formula, settlement) or its lines and evidence are not exactly the locked input lines and their evidence;
 * - `dossier_incomplete`: a party of the ownership input has no payout entry (null is explicit "none");
 * - `weight_exceeds_u64`: a slot weight does not fit the snapshot's u64 shares;
 * - `carry_not_supported`: carried remainder or deferred dust (cross-cycle carry is not persisted yet);
 * - `calculation_refused`: any refusal of the pipeline itself, with the pipeline's own code in the message.
 *
 * Simulation leaf context (pending Y6 final, D-26 and Y0 live use): network id 0, a zero cluster identity (no
 * verified cluster for fixture ownership), epoch 0.
 */
import { createHash } from "node:crypto";
import type { WeightedOwnershipInput } from "@metafarm/domain";
import {
  type CycleDistributionArtifact,
  SHA256_RFC9162_HASHER,
  SIMULATION_CLAIM_TREE_POLICY_SNAPSHOT_BOUND,
  SIMULATION_EVIDENCE_STORAGE_POLICY,
  YIELD_FORMULA_VERSIONS,
  calculateSimulationCycle,
  calculationPolicyHash,
  commitEvidence,
  emptyEvidenceLedger,
  registerEvidence,
  verifyAndNormalizeSnapshot,
} from "@metafarm/domain/yield";
import type { YieldAllocationRecord } from "@metafarm/db";
import { YieldEngineError, type YieldCalculationEngine, type YieldCalculationRequest, type YieldCalculationResult } from "./yield-engine";

const U64_MAX = 2n ** 64n - 1n;
/** RFC 9162: the hash of an empty tree is SHA-256 of the empty string. Used as the root when nothing is payable. */
export const EMPTY_TREE_ROOT = createHash("sha256").update("").digest("hex");

/** A lowercase RFC 4122 (version 4 layout) UUID derived from a 64-hex digest: deterministic snapshot ids. */
export function uuidFromDigest(hex: string): string {
  const b = hex.slice(0, 32).split("");
  b[12] = "4";
  b[16] = ((parseInt(b[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = b.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

const sideOf = (category: string) => (category === "operating_expense" ? "expense" : "revenue");

async function checkBindings(req: YieldCalculationRequest): Promise<void> {
  const { cycle, dossier } = req;
  const d = dossier!;
  const p = d.calculationPolicy;
  const mismatch = (what: string): never => {
    throw new YieldEngineError("dossier_mismatch", `the simulation dossier does not match the locked cycle: ${what}`);
  };
  if ((await calculationPolicyHash(p)) !== cycle.policyHash) mismatch("calculation policy hash");
  if (p.entitlement.sha256 !== cycle.entitlementRef) mismatch("entitlement instrument hash");
  if (p.accountingCurrency.code !== cycle.accountingCurrency) mismatch("accounting currency");
  if (p.formulaVersion !== cycle.formulaVersion) mismatch("formula version");
  if (cycle.settlementMint === null || cycle.settlementDecimals === null) mismatch("settlement unit not set");

  const expected = req.inputs
    .map((i) => {
      const sha = req.evidenceSha256ByInput[i.id] ?? null;
      if (sha === null) mismatch(`input ${i.sourceKind}:${i.sourceRef} has no evidence`);
      return { lineId: `${i.sourceKind}:${i.sourceRef}`, category: i.kind, side: i.side, amount: i.amount, currency: i.currency, completeness: i.completeness, evidenceSha256: sha! };
    })
    .sort((a, b) => (a.lineId < b.lineId ? -1 : 1));
  const given = [...d.lines].sort((a, b) => (a.lineId < b.lineId ? -1 : 1));
  if (given.length !== expected.length) mismatch(`${given.length} dossier lines for ${expected.length} locked input lines`);
  for (const [i, e] of expected.entries()) {
    const g = given[i]!;
    if (g.lineId !== e.lineId || g.category !== e.category || sideOf(g.category) !== e.side || g.amount !== e.amount || g.currency.code !== e.currency || g.completeness !== e.completeness || g.evidenceSha256 !== e.evidenceSha256)
      mismatch(`line ${e.lineId}`);
  }
  const lineEvidence = new Set(expected.map((e) => e.evidenceSha256));
  const items = new Set(d.evidence.map((x) => x.contentSha256));
  if (items.size !== d.evidence.length || items.size !== lineEvidence.size || [...items].some((x) => !lineEvidence.has(x))) mismatch("evidence items are not exactly the locked lines' evidence");
}

function snapshotInput(req: YieldCalculationRequest, o: WeightedOwnershipInput) {
  const d = req.dossier!;
  const shares = (w: bigint, who: string) => {
    if (w > U64_MAX) throw new YieldEngineError("weight_exceeds_u64", `the weight of ${who} does not fit the snapshot's u64 shares`);
    return w;
  };
  return {
    snapshotId: uuidFromDigest(o.commitment),
    assetId: req.cycle.chainAssetId,
    networkId: "simulation",
    reference: { kind: "slot" as const, value: o.window.endSlot, observedAt: d.ownershipObservedAt },
    entries: o.parties.map((p) => {
      if (!Object.prototype.hasOwnProperty.call(d.payoutAddresses, p.partyId)) throw new YieldEngineError("dossier_incomplete", `the dossier has no payout entry for party ${p.partyId} (use null for none)`);
      return { partyId: p.partyId, payoutAddress: d.payoutAddresses[p.partyId] ?? null, rawShares: shares(p.weight, p.partyId) };
    }),
    unattributed: o.unattributed.map((u) => ({ holderKey: u.holderKey, rawShares: shares(u.weight, u.holderKey) })),
  };
}

/** The stored allocation rows of an artifact: payable → allocated, withheld, unattributed; deferred dust and the carried remainder in one dust row. */
export function allocationsOf(a: CycleDistributionArtifact): YieldAllocationRecord[] {
  const rows: YieldAllocationRecord[] = [];
  let dustWeight = 0n;
  let dustAmount = a.totals.remainderCarried;
  for (const e of a.distribution.plan.entries) {
    if (e.kind === "unattributed") rows.push({ kind: "unattributed", holderKey: e.holderKey!, weight: e.weight, amount: e.amount });
    else if (e.state === "payable") rows.push({ kind: "allocated", partyId: e.partyId!, weight: e.weight, amount: e.amount });
    else if (e.state === "withheld") rows.push({ kind: "withheld", partyId: e.partyId!, weight: e.weight, amount: e.amount });
    else {
      dustWeight += e.weight;
      dustAmount += e.amount;
    }
  }
  if (dustWeight > 0n || dustAmount > 0n) rows.push({ kind: "dust", weight: dustWeight, amount: dustAmount });
  return rows;
}

export function createPipelineYieldEngine(): YieldCalculationEngine {
  return {
    name: "yield-pipeline/simulation",
    async calculate(req: YieldCalculationRequest): Promise<YieldCalculationResult> {
      const { cycle, ownership } = req;
      if (!cycle.simulation) throw new YieldEngineError("simulation_only", "the yield pipeline runs simulation cycles only", 409);
      if (!req.dossier) throw new YieldEngineError("dossier_missing", "register the cycle's simulation dossier (while in draft) before calculating");
      if (ownership.provenance.sourceKind !== "fixture")
        throw new YieldEngineError("real_network_ownership", "ownership from a verified RPC source is a real network: the simulation pipeline refuses it (devnet use needs the Y15 approval)", 409);
      const d = req.dossier;
      if (d.distributionLedger.carriedRemainder !== 0n || d.distributionLedger.deferred.length > 0) throw new YieldEngineError("carry_not_supported", "carried amounts across cycles are not persisted yet; the dossier ledger must be empty");
      await checkBindings(req);
      const formulaVersion = (YIELD_FORMULA_VERSIONS as readonly string[]).indexOf(d.calculationPolicy.formulaVersion) + 1;

      let result: Awaited<ReturnType<typeof calculateSimulationCycle>>;
      try {
        const snapshot = await verifyAndNormalizeSnapshot(snapshotInput(req, ownership), { verifiedAt: d.ownershipObservedAt });
        const ledgerCycle = { id: cycle.id, version: cycle.version, simulation: true };
        let ledger = emptyEvidenceLedger();
        for (const item of d.evidence) ledger = registerEvidence(ledger, { cycle: ledgerCycle, policy: SIMULATION_EVIDENCE_STORAGE_POLICY, item, storageRef: `sha256:${item.contentSha256}` });
        ledger = (await commitEvidence(ledger, { id: cycle.id, version: cycle.version })).ledger;
        result = await calculateSimulationCycle({
          cycle: { id: cycle.id, version: cycle.version, simulation: true, assetClass: d.assetClass },
          state: "inputs_locked",
          evidenceLedger: ledger,
          evidenceLines: [...d.lines],
          lossCarriedForward: d.lossCarriedForward,
          approvedReserveReleases: d.approvedReserveReleases,
          calculationPolicy: d.calculationPolicy,
          settlement: { mint: cycle.settlementMint!, network: "simulation", decimals: cycle.settlementDecimals!, rate: d.settlementRate },
          ownership: snapshot,
          distributionPolicy: d.distributionPolicy,
          distributionLedger: { carriedRemainder: 0n, deferred: [] },
          claimTreePolicy: SIMULATION_CLAIM_TREE_POLICY_SNAPSHOT_BOUND,
          hasher: SHA256_RFC9162_HASHER,
          leafContext: { networkId: 0, clusterIdentity: "00".repeat(32), epoch: 0, economicAssetId: cycle.chainAssetId, formulaVersion },
        });
      } catch (e) {
        if (e instanceof YieldEngineError) throw e;
        const err = e as Error & { code?: string };
        throw new YieldEngineError("calculation_refused", `${err.name}${err.code ? ` (${err.code})` : ""}: ${err.message}`);
      }
      const a = result.artifact;
      const allocations = allocationsOf(a);
      const stored = allocations.reduce((n, x) => n + x.amount, 0n);
      if (stored !== a.totals.inflow) throw new YieldEngineError("calculation_refused", `stored allocations ${stored} do not conserve the inflow ${a.totals.inflow}`);
      return {
        calculationHash: a.calculation.artifactSha256,
        allocationHash: a.distribution.planSha256,
        evidenceBundleHash: a.evidence.manifestSha256,
        merkleRoot: a.claimTree?.root ?? EMPTY_TREE_ROOT,
        setHash: result.artifactSha256,
        allocations,
        totals: Object.fromEntries(Object.entries({ ...a.totals, netDistributableYield: a.calculation.netDistributableYield, loss: a.calculation.loss }).map(([k, v]) => [k, v.toString()])),
      };
    },
  };
}
