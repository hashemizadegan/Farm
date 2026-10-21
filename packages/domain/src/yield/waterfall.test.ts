import { describe, expect, it } from "vitest";
import { YieldAmountError } from "./amounts";
import { convertAmount } from "./fx";
import { YieldRecordError } from "./records";
import { F3_ILLUSTRATION, inputs, simulationPolicy } from "./fixtures.test-support";
import { YieldCalculationError, calculateYieldWaterfall, type WaterfallInputs } from "./waterfall";

const sim = { simulation: true };
const usd1to1 = { num: 1n, den: 1n, source: "simulation-rate", observedAt: "2026-09-30T16:00:00Z" };

describe("plan examples (revision 4, §3.6; illustrative simulation fixtures)", () => {
  it("A: positive yield, F3 illustration → NDY 3,825.00 USD = 3,825,000,000 base units", () => {
    const r = calculateYieldWaterfall(sim, simulationPolicy(F3_ILLUSTRATION), inputs({ gross: 1_240_000n, refunds: 40_000n, expenses: 700_000n }));
    expect([r.netRevenue, r.operatingResult, r.resultAfterLosses, r.maintenanceReserve, r.riskReserve, r.feeBase, r.fee, r.netDistributableYield]).toEqual([
      1_200_000n,
      500_000n,
      500_000n,
      50_000n,
      25_000n,
      425_000n,
      42_500n,
      382_500n,
    ]);
    expect([r.loss, r.shortfall]).toEqual([0n, 0n]);
    // Accounting minor units (exponent 2) to a 6-decimal token at a recorded 1/1 rate: × 10^4.
    expect(convertAmount(r.netDistributableYield, 2, 6, usd1to1)).toEqual({ value: 3_825_000_000n, droppedNumerator: 0n, denominator: 100n });
  });

  it("A under each fee alternative, as the plan compares them", () => {
    const run = (fee: Parameters<typeof simulationPolicy>[0]) =>
      calculateYieldWaterfall(sim, simulationPolicy(fee), inputs({ gross: 1_240_000n, refunds: 40_000n, expenses: 700_000n })).netDistributableYield;
    expect(run({ alternative: "F1", basisPoints: 1000n, chargeInLossCycle: false, minimum: null, maximum: null })).toBe(305_000n); // 3,050.00
    expect(run({ alternative: "F2", basisPoints: 1000n, minimum: null, maximum: null })).toBe(375_000n); // 3,750.00
    expect(run(F3_ILLUSTRATION)).toBe(382_500n); // 3,825.00
    expect(run({ alternative: "F4", schedule: { kind: "fixed", amount: 30_000n }, capBasisPointsOfNetRevenue: null, chargeInLossCycle: false, minimum: null, maximum: null })).toBe(395_000n); // 3,950.00
  });

  it("B: zero yield", () => {
    const r = calculateYieldWaterfall(sim, simulationPolicy(F3_ILLUSTRATION), inputs({ gross: 600_000n, expenses: 600_000n }));
    expect([r.operatingResult, r.netDistributableYield, r.loss, r.fee, r.shortfall]).toEqual([0n, 0n, 0n, 0n, 0n]);
  });

  it("C: a loss, then recovery with the loss carried forward → NDY 1,912.50", () => {
    const c1 = calculateYieldWaterfall(sim, simulationPolicy(F3_ILLUSTRATION), inputs({ gross: 200_000n, expenses: 950_000n }));
    expect([c1.operatingResult, c1.loss, c1.netDistributableYield, c1.maintenanceReserve, c1.riskReserve]).toEqual([-750_000n, 750_000n, 0n, 0n, 0n]);
    const c2 = calculateYieldWaterfall(sim, simulationPolicy(F3_ILLUSTRATION), inputs({ gross: 1_000_000n, expenses: 0n, lcf: 750_000n }));
    expect([c2.lossCarriedForwardUsed, c2.resultAfterLosses, c2.maintenanceReserve, c2.riskReserve, c2.feeBase, c2.fee, c2.netDistributableYield]).toEqual([
      750_000n,
      250_000n,
      25_000n,
      12_500n,
      212_500n,
      21_250n,
      191_250n,
    ]);
  });

  it("D: partial payment on a cash basis equals A when only the received 12,000.00 is revenue", () => {
    const r = calculateYieldWaterfall(sim, simulationPolicy(F3_ILLUSTRATION), inputs({ gross: 1_200_000n, expenses: 700_000n }));
    expect(r.netDistributableYield).toBe(382_500n);
  });
});

describe("fee behaviour by alternative", () => {
  const loss: WaterfallInputs = inputs({ gross: 200_000n, expenses: 950_000n }); // R = 2,000.00, OR = −7,500.00

  it("F1 and F4 charge in a loss cycle only when the policy says so, and report the uncovered fee as shortfall", () => {
    const f1 = (charge: boolean) => calculateYieldWaterfall(sim, simulationPolicy({ alternative: "F1", basisPoints: 1000n, chargeInLossCycle: charge, minimum: null, maximum: null }), loss);
    expect([f1(false).fee, f1(false).shortfall]).toEqual([0n, 0n]);
    expect([f1(true).fee, f1(true).shortfall, f1(true).loss, f1(true).netDistributableYield]).toEqual([20_000n, 20_000n, 750_000n, 0n]);
    const f4 = (charge: boolean) =>
      calculateYieldWaterfall(sim, simulationPolicy({ alternative: "F4", schedule: { kind: "fixed", amount: 30_000n }, capBasisPointsOfNetRevenue: null, chargeInLossCycle: charge, minimum: null, maximum: null }), loss);
    expect(f4(false).fee).toBe(0n);
    expect([f4(true).fee, f4(true).shortfall]).toEqual([30_000n, 30_000n]);
  });

  it("F2 and F3 charge nothing when their base is not positive", () => {
    for (const fee of [{ alternative: "F2", basisPoints: 1000n, minimum: 5_000n, maximum: null } as const, { ...F3_ILLUSTRATION, minimum: 5_000n }]) {
      const r = calculateYieldWaterfall(sim, simulationPolicy(fee), loss);
      expect(r.fee).toBe(0n);
    }
  });

  it("applies minimum and maximum, and reports a minimum the result cannot cover as shortfall", () => {
    const small = inputs({ gross: 101_000n, expenses: 100_000n }); // OR = 10.00
    const r = calculateYieldWaterfall(sim, simulationPolicy({ alternative: "F2", basisPoints: 1000n, minimum: 5_000n, maximum: null }), small);
    // M = 100, I = 50, P = max(100, 5000) = 5000 → raw = 1000 − 150 − 5000 = −4150.
    expect([r.fee, r.netDistributableYield, r.shortfall, r.loss]).toEqual([5_000n, 0n, 4_150n, 0n]);
    const capped = calculateYieldWaterfall(sim, simulationPolicy({ alternative: "F2", basisPoints: 1000n, minimum: null, maximum: 10_000n }), inputs({ gross: 1_240_000n, refunds: 40_000n, expenses: 700_000n }));
    expect(capped.fee).toBe(10_000n);
  });

  it("F4: tiers by net revenue, and a cap as a share of net revenue", () => {
    const tiers = { kind: "tiered", tiers: [{ fromNetRevenue: 0n, amount: 10_000n }, { fromNetRevenue: 1_000_000n, amount: 40_000n }] } as const;
    const fee = (gross: bigint, cap: bigint | null) =>
      calculateYieldWaterfall(sim, simulationPolicy({ alternative: "F4", schedule: tiers, capBasisPointsOfNetRevenue: cap, chargeInLossCycle: false, minimum: null, maximum: null }), inputs({ gross, expenses: 0n })).fee;
    expect(fee(999_999n, null)).toBe(10_000n);
    expect(fee(1_000_000n, null)).toBe(40_000n);
    expect(fee(1_000_000n, 300n)).toBe(30_000n); // capped at 3% of R
    const loss = inputs({ gross: 0n, expenses: 1n });
    expect(() =>
      calculateYieldWaterfall(sim, simulationPolicy({ alternative: "F4", schedule: { kind: "tiered", tiers: [{ fromNetRevenue: 5n, amount: 1n }] }, capBasisPointsOfNetRevenue: null, chargeInLossCycle: true, minimum: null, maximum: null }), loss),
    ).toThrow(YieldCalculationError);
  });
});

describe("rounding, caps and reported fractions", () => {
  it("rounds reserves and fee down and reports the dropped basis-point numerators", () => {
    const r = calculateYieldWaterfall(sim, simulationPolicy({ alternative: "F2", basisPoints: 333n, minimum: null, maximum: null }), inputs({ gross: 10_001n, expenses: 0n }));
    // M = floor(10001 × 1000 / 10000) = 1000 r 1000; I = floor(10001 × 500 / 10000) = 500 r 500; P = floor(10001 × 333 / 10000) = 333 r 333.
    expect([r.maintenanceReserve, r.riskReserve, r.fee]).toEqual([1000n, 500n, 333n]);
    expect(r.droppedBasisPointNumerators).toEqual({ maintenance: 1000n, risk: 500n, fee: 333n, feeCap: 0n });
    expect(r.netDistributableYield).toBe(10_001n - 1000n - 500n - 333n);
  });

  it("applies reserve caps", () => {
    const r = calculateYieldWaterfall(sim, simulationPolicy(F3_ILLUSTRATION, { reserves: { maintenanceBasisPoints: 1000n, maintenanceCap: 10_000n, riskBasisPoints: 500n, riskCap: 0n } }), inputs({ gross: 1_200_000n, expenses: 700_000n }));
    expect([r.maintenanceReserve, r.riskReserve]).toEqual([10_000n, 0n]);
  });
});

describe("refusals: nothing is assumed, defaulted or absorbed", () => {
  const base = simulationPolicy(F3_ILLUSTRATION);
  const ok = inputs({ gross: 1_000n, expenses: 0n });

  it("refuses unknown costs, mis-marked zeros, duplicates and estimates the policy does not allow", () => {
    const withLines = (expenses: WaterfallInputs["expenses"]) => ({ ...ok, expenses });
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as YieldCalculationError).code;
      }
      return "no error";
    };
    expect(err(() => calculateYieldWaterfall(sim, base, withLines([{ id: "x", amount: null, completeness: "unknown" }])))).toBe("unknown_cost");
    expect(err(() => calculateYieldWaterfall(sim, base, withLines([{ id: "x", amount: 5n, completeness: "zero" }])))).toBe("invalid_cost_line");
    expect(err(() => calculateYieldWaterfall(sim, base, withLines([{ id: "x", amount: 1n, completeness: "known" }, { id: "x", amount: 2n, completeness: "known" }])))).toBe("duplicate_cost_line");
    expect(err(() => calculateYieldWaterfall(sim, base, withLines([{ id: "e", amount: 1n, completeness: "estimated" }])))).toBe("estimated_cost_not_allowed");
    const allowed = calculateYieldWaterfall(sim, simulationPolicy(F3_ILLUSTRATION, { allowEstimatedCosts: true }), withLines([{ id: "e", amount: 1n, completeness: "estimated" }]));
    expect(allowed.estimatedCostLines).toEqual(["e"]);
  });

  it("refuses a carried loss when carry-forward is off, and releases into a loss cycle", () => {
    expect(() => calculateYieldWaterfall(sim, simulationPolicy(F3_ILLUSTRATION, { lossCarryForward: { enabled: false } }), { ...ok, lossCarriedForward: 1n })).toThrow(/does not carry losses forward/);
    expect(() => calculateYieldWaterfall(sim, base, { ...inputs({ gross: 0n, expenses: 10n }), approvedReserveReleases: 5n })).toThrow(/D-7/);
  });

  it("refuses numbers (floats or integers) where bigints are required, and negative inputs", () => {
    expect(() => calculateYieldWaterfall(sim, base, { ...ok, grossRevenue: 1000 as never })).toThrow(YieldAmountError);
    expect(() => calculateYieldWaterfall(sim, base, { ...ok, refunds: -1n })).toThrow(YieldAmountError);
    expect(() => calculateYieldWaterfall(sim, base, { ...ok, expenses: [{ id: "x", amount: 1.5 as never, completeness: "known" }] })).toThrow(YieldAmountError);
  });

  it("refuses unsupported input keys and cost-line keys instead of ignoring them", () => {
    // A misspelt or unmodelled field would otherwise silently drop money from the waterfall.
    expect(() => calculateYieldWaterfall(sim, base, { ...ok, bankFees: 2_170n } as never)).toThrow(/unsupported keys: bankFees/);
    expect(() => calculateYieldWaterfall(sim, base, { ...ok, expenses: [{ id: "x", amount: 1n, completeness: "known", currency: "EUR" }] as never })).toThrow(/unsupported keys: currency/);
  });

  it("uses only policies whose status fits the cycle", () => {
    expect(() => calculateYieldWaterfall({ simulation: false }, base, ok)).toThrow(YieldRecordError);
    expect(() => calculateYieldWaterfall(sim, { ...base, status: "approved" }, ok)).toThrow(YieldRecordError);
    expect(() => calculateYieldWaterfall({ simulation: false }, { ...base, status: "draft" }, ok)).toThrow(YieldRecordError);
    // An approved policy is usable by a real cycle; nothing else is checked here about whether it truly is approved.
    expect(calculateYieldWaterfall({ simulation: false }, { ...base, status: "approved" }, ok).netDistributableYield).toBeGreaterThan(0n);
  });
});

describe("determinism", () => {
  it("gives identical results for identical inputs", () => {
    const a = calculateYieldWaterfall(sim, simulationPolicy(F3_ILLUSTRATION), inputs({ gross: 1_240_000n, refunds: 40_000n, expenses: 700_000n }));
    const b = calculateYieldWaterfall(sim, simulationPolicy(F3_ILLUSTRATION), inputs({ gross: 1_240_000n, refunds: 40_000n, expenses: 700_000n }));
    expect(a).toEqual(b);
  });
});
