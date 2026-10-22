/**
 * A simulation scenario for the yield pipeline engine (tests only): a simulation calculation policy (F3, 10 %
 * fees, 10 % + 5 % reserves), one revenue and one expense line with their evidence, and the dossier around them.
 * Every record is simulation-labelled; none of these values is a policy.
 */
import { SIMULATION_DISTRIBUTION_POLICY, type SimulationDossier, type YieldCalculationPolicy } from "@metafarm/domain/yield";

export const h = (n: number) => n.toString(16).padStart(64, "0");

export const POLICY: YieldCalculationPolicy = {
  id: "simulation-policy",
  version: 1,
  status: "simulation",
  formulaVersion: "yield-formula/1",
  entitlement: { id: "simulation-entitlement", version: "illustration", sha256: "ab".repeat(32) },
  accountingCurrency: { code: "USD", exponent: 2 },
  conversionDateRule: "settlement_date",
  recognitionBasis: "cash",
  lossCarryForward: { enabled: true },
  reserves: { maintenanceBasisPoints: 1000n, maintenanceCap: null, riskBasisPoints: 500n, riskCap: null },
  fee: { alternative: "F3", basisPoints: 1000n, minimum: null, maximum: null },
  allowEstimatedCosts: false,
};

export const item = (n: number, sourceId: string) => ({
  type: "sales_invoice" as const,
  contentSha256: h(n),
  byteSize: 10,
  mediaType: "application/pdf",
  issuedAt: "2026-03-30T10:00:00+03:30",
  timeZone: "Asia/Tehran",
  sourceId,
  recordedBy: "preparer-1",
  recordedAt: "2026-04-01T08:00:00Z",
  classification: "confidential" as const,
  retentionClassId: "simulation-retention",
  supersedes: null,
});

export const dossierFor = (payoutAddresses: Record<string, string | null>): SimulationDossier => ({
  scheme: "metafarm-yield-simulation-dossier/1",
  assetClass: "crop",
  calculationPolicy: POLICY,
  settlementRate: { num: 1n, den: 1n, source: "simulation-peg", observedAt: "2026-03-31T16:00:00Z" },
  distributionPolicy: SIMULATION_DISTRIBUTION_POLICY,
  distributionLedger: { carriedRemainder: 0n, deferred: [] },
  lossCarriedForward: 0n,
  approvedReserveReleases: 0n,
  evidence: [item(1, "INV-1"), item(2, "EXP-1")],
  lines: [
    { lineId: "invoice:INV-1", evidenceSha256: h(1), category: "gross_revenue", amount: 800_000n, currency: { code: "USD", exponent: 2 }, completeness: "known", rate: null },
    { lineId: "invoice:EXP-1", evidenceSha256: h(2), category: "operating_expense", amount: 300_000n, currency: { code: "USD", exponent: 2 }, completeness: "known", rate: null },
  ],
  payoutAddresses,
  ownershipObservedAt: "2026-03-31T23:59:59Z",
});

