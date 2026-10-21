/**
 * Test fixtures only (not exported from the package). Examples A–G from the real yield plan (revision 4,
 * §3.6) are **illustrative simulation fixtures**: their policy values are the plan's illustration (F3,
 * m = 10%, i = 5%, p = 10%), not an approved policy, and every record here is labelled `simulation`.
 */
import type { FeePolicy, YieldCalculationPolicy } from "./policy";
import type { WaterfallInputs } from "./waterfall";

export const SIMULATION_ENTITLEMENT = { id: "simulation-entitlement", version: "illustration", sha256: "ab".repeat(32) };

export function simulationPolicy(fee: FeePolicy, overrides: Partial<YieldCalculationPolicy> = {}): YieldCalculationPolicy {
  return {
    id: "simulation-policy",
    version: 1,
    status: "simulation",
    formulaVersion: "yield-formula/1",
    entitlement: SIMULATION_ENTITLEMENT,
    accountingCurrency: { code: "USD", exponent: 2 },
    conversionDateRule: "settlement_date",
    recognitionBasis: "cash",
    lossCarryForward: { enabled: true },
    reserves: { maintenanceBasisPoints: 1000n, maintenanceCap: null, riskBasisPoints: 500n, riskCap: null },
    fee,
    allowEstimatedCosts: false,
    ...overrides,
  };
}

export const F3_ILLUSTRATION: FeePolicy = { alternative: "F3", basisPoints: 1000n, minimum: null, maximum: null };

/** USD minor units (exponent 2). */
export function inputs(o: { gross: bigint; refunds?: bigint; expenses: bigint; lcf?: bigint }): WaterfallInputs {
  return {
    grossRevenue: o.gross,
    refunds: o.refunds ?? 0n,
    chargebacks: 0n,
    rebates: 0n,
    taxesCollected: 0n,
    expenses: [{ id: "costs", amount: o.expenses, completeness: "known" }],
    lossCarriedForward: o.lcf ?? 0n,
    approvedReserveReleases: 0n,
  };
}
