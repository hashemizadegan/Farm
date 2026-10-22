import { describe, expect, it } from "vitest";
import {
  type AggregationError,
  type EvidenceLine,
  SIMULATION_RESERVE_OFFSET_POLICY,
  aggregateAndCalculate,
  aggregateEvidence,
  estimateReserveOffsetCeiling,
  reserveOffsetPolicyProblems,
} from "./aggregation";
import { type EvidenceItem, buildEvidenceManifest } from "./evidence";
import { F3_ILLUSTRATION, simulationPolicy } from "./fixtures.test-support";
import { YieldRecordError } from "./records";
import { YieldCalculationError } from "./waterfall";

const cycle = { id: "sim-cycle-1", version: 1, simulation: true };
const policy = simulationPolicy(F3_ILLUSTRATION);
const USD = { code: "USD", exponent: 2 };
const EUR = { code: "EUR", exponent: 2 };
const h = (n: number) => n.toString(16).padStart(64, "0");
const item = (n: number, type: EvidenceItem["type"], sourceId: string, supersedes: string | null = null): EvidenceItem => ({
  type,
  contentSha256: h(n),
  byteSize: 1,
  mediaType: "application/pdf",
  issuedAt: "2026-09-30T10:00:00+03:30",
  timeZone: null,
  sourceId,
  recordedBy: "user-1",
  recordedAt: "2026-10-01T08:00:00Z",
  classification: "confidential",
  retentionClassId: "simulation-retention",
  supersedes,
});
const line = (lineId: string, n: number, category: EvidenceLine["category"], amount: bigint | null, patch: Partial<EvidenceLine> = {}): EvidenceLine => ({
  lineId,
  evidenceSha256: h(n),
  category,
  amount,
  currency: USD,
  completeness: "known",
  rate: null,
  ...patch,
});
const manifest = (items: EvidenceItem[]) => buildEvidenceManifest({ cycleId: cycle.id, cycleVersion: cycle.version, items });
const run = (items: EvidenceItem[], lines: EvidenceLine[], patch: Record<string, unknown> = {}) =>
  aggregateEvidence({ cycle, policy, manifest: manifest(items), lines, lossCarriedForward: 0n, approvedReserveReleases: 0n, ...patch });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as AggregationError).code ?? (e as Error).name;
  }
  return "no error";
};

// Plan example A as evidence: an invoice for 12,400.00, a refund note for 400.00, two cost receipts.
const A_ITEMS = [item(1, "sales_invoice", "INV-1"), item(2, "sales_invoice", "CN-1"), item(3, "weighbridge_receipt", "WB-1"), item(4, "warehouse_receipt", "WH-1")];
const A_LINES = [
  line("rev-1", 1, "gross_revenue", 1_240_000n),
  line("ref-1", 2, "refund", 40_000n),
  line("cost-transport", 3, "operating_expense", 200_000n),
  line("cost-storage", 4, "operating_expense", 500_000n),
];

describe("evidence aggregation", () => {
  it("A: aggregates evidence into the waterfall and reproduces NDY 3,825.00", () => {
    const r = aggregateAndCalculate({ cycle, policy, manifest: manifest(A_ITEMS), lines: A_LINES, lossCarriedForward: 0n, approvedReserveReleases: 0n });
    expect(r.inputs).toMatchObject({ grossRevenue: 1_240_000n, refunds: 40_000n, chargebacks: 0n, rebates: 0n, taxesCollected: 0n });
    expect(r.inputs.expenses.map((e) => e.id)).toEqual(["cost-storage", "cost-transport"]);
    expect(r.result.netDistributableYield).toBe(382_500n);
    expect(r.provenance.map((p) => [p.lineId, p.sourceId])).toEqual([
      ["cost-storage", "WH-1"],
      ["cost-transport", "WB-1"],
      ["ref-1", "CN-1"],
      ["rev-1", "INV-1"],
    ]);
  });

  it("E: converts a EUR line at a recorded 217/200 to 1,085,000 USD minor units, and records the conversion", () => {
    const rate = { num: 217n, den: 200n, source: "simulation-rate", observedAt: "2026-09-30T16:00:00Z" };
    const r = run([item(1, "sales_invoice", "INV-EUR"), item(2, "bank_settlement_record", "FEE-1")], [line("rev", 1, "gross_revenue", 1_000_000n, { currency: EUR, rate }), line("fee", 2, "operating_expense", 2_170n)]);
    expect(r.inputs.grossRevenue).toBe(1_085_000n);
    expect(r.provenance.find((p) => p.lineId === "rev")!.conversion).toEqual({ value: 1_085_000n, droppedNumerator: 0n, denominator: 20_000n });
    expect(r.inputs.expenses).toEqual([{ id: "fee", amount: 2_170n, completeness: "known" }]);
  });

  it("reports the fraction dropped by a conversion", () => {
    const rate = { num: 1n, den: 3n, source: "simulation-rate", observedAt: "2026-09-30T16:00:00Z" };
    const r = run([item(1, "sales_invoice", "INV")], [line("rev", 1, "gross_revenue", 100n, { currency: EUR, rate })]);
    expect(r.inputs.grossRevenue).toBe(33n);
    expect(r.provenance[0]!.conversion).toEqual({ value: 33n, droppedNumerator: 100n, denominator: 300n });
  });

  it("refuses double counting by evidence hash or by source reference (plan §3.4)", () => {
    expect(code(() => run([item(1, "sales_invoice", "INV-1")], [line("a", 1, "gross_revenue", 1n), line("b", 1, "gross_revenue", 1n)]))).toBe("double_counted");
    // Two documents with the same invoice number (e.g. a scan and an XML of the same invoice).
    expect(code(() => run([item(1, "sales_invoice", "INV-1"), item(2, "customs_record", "INV-1")], [line("a", 1, "gross_revenue", 1n), line("b", 2, "gross_revenue", 1n)]))).toBe("double_counted");
  });

  it("refuses lines backed by evidence outside the manifest or superseded within it", () => {
    expect(code(() => run([item(1, "sales_invoice", "INV-1")], [line("a", 9, "gross_revenue", 1n)]))).toBe("unknown_evidence");
    const items = [item(1, "sales_invoice", "INV-1"), item(2, "sales_invoice", "INV-1-corrected", h(1))];
    expect(code(() => run(items, [line("a", 1, "gross_revenue", 1n)]))).toBe("superseded_evidence");
    expect(run(items, [line("a", 2, "gross_revenue", 1n)]).inputs.grossRevenue).toBe(1n);
  });

  it("requires a rate for foreign currency, refuses one for the accounting currency, and refuses exponent mismatches", () => {
    const items = [item(1, "sales_invoice", "INV")];
    expect(code(() => run(items, [line("a", 1, "gross_revenue", 1n, { currency: EUR })]))).toBe("rate_required");
    expect(code(() => run(items, [line("a", 1, "gross_revenue", 1n, { rate: { num: 1n, den: 1n, source: "s", observedAt: "2026-09-30T16:00:00Z" } })]))).toBe("rate_not_allowed");
    expect(code(() => run(items, [line("a", 1, "gross_revenue", 1n, { currency: { code: "USD", exponent: 3 } })]))).toBe("currency_mismatch");
    expect(code(() => run(items, [line("a", 1, "gross_revenue", 1n, { currency: { code: "eur", exponent: 2 }, rate: { num: 1n, den: 1n, source: "s", observedAt: "2026-09-30T16:00:00Z" } })]))).toBe("invalid_line");
  });

  it("passes cost completeness through, so unknown costs are still refused by the waterfall", () => {
    const items = [item(1, "sales_invoice", "INV"), item(2, "warehouse_receipt", "WH")];
    const r = run(items, [line("rev", 1, "gross_revenue", 10n), line("cost", 2, "operating_expense", null, { completeness: "unknown" })]);
    expect(r.inputs.expenses).toEqual([{ id: "cost", amount: null, completeness: "unknown" }]);
    expect(() => aggregateAndCalculate({ cycle, policy, manifest: manifest(items), lines: [line("rev", 1, "gross_revenue", 10n), line("cost", 2, "operating_expense", null, { completeness: "unknown" })], lossCarriedForward: 0n, approvedReserveReleases: 0n })).toThrow(YieldCalculationError);
    expect(code(() => run(items, [line("rev", 1, "gross_revenue", null, { completeness: "unknown" })]))).toBe("invalid_line");
    expect(code(() => run(items, [line("rev", 1, "gross_revenue", 10n, { completeness: "estimated" })]))).toBe("invalid_line");
  });

  it("is independent of line order, and refuses repeated ids, unsupported keys and a manifest of another cycle", () => {
    const a = run(A_ITEMS, A_LINES);
    const b = run(A_ITEMS, [...A_LINES].reverse());
    expect(b).toEqual(a);
    expect(code(() => run(A_ITEMS, [line("x", 1, "gross_revenue", 1n), line("x", 2, "refund", 1n)]))).toBe("invalid_line");
    expect(code(() => run(A_ITEMS, [{ ...line("x", 1, "gross_revenue", 1n), vat: 1n } as never]))).toBe("invalid_parameter");
    const other = buildEvidenceManifest({ cycleId: "other", cycleVersion: 1, items: A_ITEMS });
    expect(code(() => aggregateEvidence({ cycle, policy, manifest: other, lines: A_LINES, lossCarriedForward: 0n, approvedReserveReleases: 0n }))).toBe("manifest_mismatch");
  });

  it("uses only policies usable for the cycle", () => {
    expect(code(() => aggregateEvidence({ cycle: { ...cycle, simulation: false }, policy, manifest: manifest(A_ITEMS), lines: A_LINES, lossCarriedForward: 0n, approvedReserveReleases: 0n }))).toBe("YieldRecordError");
  });
});

describe("reserve offset ceiling (estimate only, pending D-7)", () => {
  const est = (loss: bigint, risk: bigint, maintenance = 0n, policyPatch: Partial<typeof SIMULATION_RESERVE_OFFSET_POLICY> = {}) =>
    estimateReserveOffsetCeiling({ cycle: { simulation: true }, policy: { ...SIMULATION_RESERVE_OFFSET_POLICY, ...policyPatch }, loss, balances: { maintenance, risk } });

  it("C, cycle 1: a 7,500.00 loss against a 1,000.00 risk reserve can be offset by at most 1,000.00", () => {
    expect(est(750_000n, 100_000n)).toEqual({ ceiling: 100_000n, eligibleBalance: 100_000n, lossCap: 750_000n, balanceCap: 100_000n, binding: "balance", estimateOnly: true });
  });

  it("counts only eligible reserves, and applies both caps, rounding down", () => {
    expect(est(750_000n, 100_000n, 5_000_000n).eligibleBalance).toBe(100_000n);
    expect(est(750_000n, 100_000n, 5_000_000n, { eligibleReserves: ["maintenance", "risk"] }).ceiling).toBe(750_000n);
    expect(est(1_001n, 10_000_000n, 0n, { maxBasisPointsOfLoss: 5_000n })).toMatchObject({ ceiling: 500n, binding: "loss" });
    expect(est(10_000_000n, 1_001n, 0n, { maxBasisPointsOfBalance: 3_333n })).toMatchObject({ ceiling: 333n, binding: "balance" });
  });

  it("is zero with no loss or no eligible balance", () => {
    expect(est(0n, 100n)).toMatchObject({ ceiling: 0n, binding: "none" });
    expect(est(100n, 0n)).toMatchObject({ ceiling: 0n, binding: "none" });
    expect(est(100n, 0n, 100n, { eligibleReserves: [] })).toMatchObject({ ceiling: 0n, binding: "none" });
  });

  it("is simulation-only until D-7: real cycles need an approved policy", () => {
    expect(() => estimateReserveOffsetCeiling({ cycle: { simulation: false }, policy: SIMULATION_RESERVE_OFFSET_POLICY, loss: 1n, balances: { maintenance: 0n, risk: 1n } })).toThrow(YieldRecordError);
  });

  it("validates the policy and inputs", () => {
    expect(reserveOffsetPolicyProblems(SIMULATION_RESERVE_OFFSET_POLICY)).toEqual([]);
    expect(reserveOffsetPolicyProblems({})).toHaveLength(6);
    expect(reserveOffsetPolicyProblems({ ...SIMULATION_RESERVE_OFFSET_POLICY, eligibleReserves: ["risk", "risk"] })).toHaveLength(1);
    expect(reserveOffsetPolicyProblems({ ...SIMULATION_RESERVE_OFFSET_POLICY, maxBasisPointsOfLoss: 10_001n })).toHaveLength(1);
    expect(reserveOffsetPolicyProblems({ ...SIMULATION_RESERVE_OFFSET_POLICY, climate: true })).toHaveLength(1);
    expect(() => est(-1n, 0n)).toThrow();
    expect(() => estimateReserveOffsetCeiling({ cycle: { simulation: true }, policy: SIMULATION_RESERVE_OFFSET_POLICY, loss: 1n, balances: { maintenance: 0n, risk: 1n, climate: 1n } as never })).toThrow();
  });
});
