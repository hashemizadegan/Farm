/**
 * The multi-party simulation scenario of the cycle pipeline (PR #73), shared by its tests and by the
 * claim-payload sample generator, so the C# client is checked against exactly this scenario's artifact.
 * Simulation records only.
 */
import type { EvidenceLine } from "./aggregation";
import { SHA256_RFC9162_HASHER, SIMULATION_CLAIM_TREE_POLICY_SNAPSHOT_BOUND } from "./claim-tree";
import { SIMULATION_DISTRIBUTION_POLICY, emptyDistributionLedger } from "./distribution";
import type { EvidenceItem } from "./evidence";
import { SIMULATION_EVIDENCE_STORAGE_POLICY, commitEvidence, emptyEvidenceLedger, registerEvidence, type EvidenceLedger } from "./evidence-store";
import { F3_ILLUSTRATION, simulationPolicy } from "./fixtures.test-support";
import { type OwnershipSnapshotInput, verifyAndNormalizeSnapshot } from "./ownership-snapshot";
import type { SimulationCycleInput } from "./pipeline";

export const CYCLE = { id: "00000000-0000-4000-8000-0000000000c1", version: 1, simulation: true, assetClass: "crop" };
export const USD = { code: "USD", exponent: 2 };
export const EUR = { code: "EUR", exponent: 2 };
export const EUR_USD = { num: 217n, den: 200n, source: "simulation-rate", observedAt: "2026-09-30T16:00:00Z" };
export const h = (n: number) => n.toString(16).padStart(64, "0");
export const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((x) => parseInt(x, 16)));

export const item = (n: number, type: EvidenceItem["type"], sourceId: string): EvidenceItem => ({
  type,
  contentSha256: h(n),
  byteSize: 10,
  mediaType: "application/pdf",
  issuedAt: "2026-09-30T10:00:00+03:30",
  timeZone: "Asia/Tehran",
  sourceId,
  recordedBy: "preparer-1",
  recordedAt: "2026-10-01T08:00:00Z",
  classification: "confidential",
  retentionClassId: "simulation-retention",
  supersedes: null,
});
export const ITEMS = [item(1, "sales_invoice", "INV-USD-1"), item(2, "sales_invoice", "INV-EUR-1"), item(3, "sales_invoice", "CN-1"), item(4, "weighbridge_receipt", "WB-1"), item(5, "warehouse_receipt", "WH-1")];
export const line = (lineId: string, n: number, category: EvidenceLine["category"], amount: bigint, patch: Partial<EvidenceLine> = {}): EvidenceLine => ({ lineId, evidenceSha256: h(n), category, amount, currency: USD, completeness: "known", rate: null, ...patch });

// R = 8,000.00 + (4,000.00 EUR at 217/200 = 4,340.00) − 340.00 = 12,000.00; O = 3,000.00 + 2,000.00 = 5,000.00.
// F3 illustration: OR = OR' = 7,000.00; M = 700.00; I = 350.00; P = 10% of 5,950.00 = 595.00; NDY = 5,355.00.
export const LINES = [
  line("rev-usd", 1, "gross_revenue", 800_000n),
  line("rev-eur", 2, "gross_revenue", 400_000n, { currency: EUR, rate: EUR_USD }),
  line("refund", 3, "refund", 34_000n),
  line("cost-transport", 4, "operating_expense", 300_000n),
  line("cost-storage", 5, "operating_expense", 200_000n),
];

// Raw shares: A 50, B 30, C 15 (no payout address), unattributed 4, D 1 (below the dust threshold).
export const SNAPSHOT_INPUT: OwnershipSnapshotInput = {
  snapshotId: "00000000-0000-4000-8000-0000000000e1",
  assetId: "bb".repeat(32),
  networkId: "simulation",
  reference: { kind: "slot", value: 123_456_789n, observedAt: "2026-09-30T23:59:59Z" },
  entries: [
    { partyId: "party-a", payoutAddress: "01".repeat(32), rawShares: 50n },
    { partyId: "party-b", payoutAddress: "So11111111111111111111111111111111111111112", rawShares: 30n },
    { partyId: "party-c", payoutAddress: null, rawShares: 15n },
    { partyId: "party-d", payoutAddress: "03".repeat(32), rawShares: 1n, metadata: { note: "simulation holder" } },
  ],
  unattributed: [{ holderKey: "token-account-x", rawShares: 4n }],
};
export const VERIFIED_AT = "2026-10-01T09:00:00Z";
export const scenarioSnapshot = (patch: Partial<OwnershipSnapshotInput> = {}) => verifyAndNormalizeSnapshot({ ...SNAPSHOT_INPUT, ...patch }, { verifiedAt: VERIFIED_AT });

export const ledgerCycle = (c: typeof CYCLE) => ({ id: c.id, version: c.version, simulation: c.simulation });

export async function committedLedger(cycle = CYCLE, items = ITEMS): Promise<EvidenceLedger> {
  let ledger = emptyEvidenceLedger();
  for (const i of items) ledger = registerEvidence(ledger, { cycle: ledgerCycle(cycle), policy: SIMULATION_EVIDENCE_STORAGE_POLICY, item: i, storageRef: `sha256:${i.contentSha256}` });
  return (await commitEvidence(ledger, cycle)).ledger;
}

export async function input(patch: Partial<SimulationCycleInput> = {}): Promise<SimulationCycleInput> {
  return {
    cycle: CYCLE,
    state: "inputs_locked",
    evidenceLedger: await committedLedger(),
    evidenceLines: LINES,
    lossCarriedForward: 0n,
    approvedReserveReleases: 0n,
    calculationPolicy: simulationPolicy(F3_ILLUSTRATION),
    settlement: { mint: "So11111111111111111111111111111111111111112", network: "simulation", decimals: 6, rate: { num: 1n, den: 1n, source: "simulation-peg", observedAt: "2026-09-30T16:00:00Z" } },
    ownership: await scenarioSnapshot(),
    distributionPolicy: { ...SIMULATION_DISTRIBUTION_POLICY, dustThreshold: 60_000_000n, missingPayoutWallet: "withhold" },
    distributionLedger: emptyDistributionLedger(),
    claimTreePolicy: SIMULATION_CLAIM_TREE_POLICY_SNAPSHOT_BOUND,
    hasher: SHA256_RFC9162_HASHER,
    leafContext: { networkId: 7, clusterIdentity: "aa".repeat(32), epoch: 0, economicAssetId: "bb".repeat(32), formulaVersion: 1 },
    ...patch,
  };
}

