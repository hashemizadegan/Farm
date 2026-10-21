/**
 * The yield waterfall (plan revision 4, §3.3), in accounting-currency minor units:
 *
 *   R    = gross − refunds − chargebacks − rebates − taxes collected
 *   O    = Σ operating expenses
 *   OR   = R − O
 *   LCF_used = min(max(OR, 0), LCF) when carry-forward is enabled, else 0
 *   OR'  = OR − LCF_used
 *   M, I = reserve additions on OR' when OR' > 0, else 0 (rounded down, capped)
 *   P    = fee by the policy's alternative F1–F4
 *   NDY  = max(0, OR' − M − I − P + REL)
 *
 * What the plan leaves open is reported, not decided:
 * - `loss` is max(−OR, 0). Whether a fee charged in a loss cycle adds to the carried loss is not decided
 *   here: the fee and any `shortfall` are reported separately.
 * - `shortfall` is the part of the fee that the result does not cover (reserve additions never exceed
 *   OR′, so they are always covered); it is reported, never absorbed, and its treatment is not decided.
 * - Reserve releases (REL) in a loss cycle are refused: whether reserves may cover losses is D-7.
 */
import { YieldAmountError, applyBasisPoints, assertExactKeys, assertNonNegative } from "./amounts";
import { assertYieldPolicy, type FeePolicy, type YieldCalculationPolicy } from "./policy";
import { assertYieldRecordUsable } from "./records";

export const COST_COMPLETENESS = ["known", "zero", "estimated", "unknown"] as const;
export type CostCompleteness = (typeof COST_COMPLETENESS)[number];

export interface CostLine {
  /** Unique within the cycle; a source reference may back only one line. */
  id: string;
  /** Accounting minor units; null only when unknown. */
  amount: bigint | null;
  completeness: CostCompleteness;
}

export interface WaterfallInputs {
  grossRevenue: bigint;
  refunds: bigint;
  chargebacks: bigint;
  rebates: bigint;
  taxesCollected: bigint;
  expenses: readonly CostLine[];
  /** Loss carried forward from earlier cycles, after any expiry the policy applies. */
  lossCarriedForward: bigint;
  /** Approved reserve releases into this cycle (REL). */
  approvedReserveReleases: bigint;
}

export interface WaterfallResult {
  netRevenue: bigint;
  operatingExpenses: bigint;
  operatingResult: bigint;
  lossCarriedForwardUsed: bigint;
  resultAfterLosses: bigint;
  maintenanceReserve: bigint;
  riskReserve: bigint;
  fee: bigint;
  /** The amount the fee percentage or schedule was applied to, or null for a fixed or tiered fee. */
  feeBase: bigint | null;
  approvedReserveReleases: bigint;
  netDistributableYield: bigint;
  loss: bigint;
  shortfall: bigint;
  estimatedCostLines: string[];
  /** Fractions dropped by rounding down, as numerators over 10000 (basis points). */
  droppedBasisPointNumerators: { maintenance: bigint; risk: bigint; fee: bigint; feeCap: bigint };
}

export type YieldCalculationErrorCode = "unknown_cost" | "estimated_cost_not_allowed" | "invalid_cost_line" | "duplicate_cost_line" | "carry_forward_disabled" | "release_in_loss_cycle" | "no_fee_tier";

export class YieldCalculationError extends Error {
  constructor(
    readonly code: YieldCalculationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "YieldCalculationError";
  }
}

const COST_LINE_KEYS = ["id", "amount", "completeness"] as const;
const INPUT_KEYS = ["grossRevenue", "refunds", "chargebacks", "rebates", "taxesCollected", "expenses", "lossCarriedForward", "approvedReserveReleases"] as const;

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const cap = (v: bigint, c: bigint | null) => (c === null ? v : min(v, c));

function operatingExpenses(lines: readonly CostLine[], allowEstimated: boolean): { total: bigint; estimated: string[] } {
  if (!Array.isArray(lines)) throw new YieldCalculationError("invalid_cost_line", "expenses must be a list");
  const ids = new Set<string>();
  let total = 0n;
  const estimated: string[] = [];
  for (const l of lines) {
    assertExactKeys("cost line", l, COST_LINE_KEYS);
    if (typeof l.id !== "string" || l.id === "") throw new YieldCalculationError("invalid_cost_line", "every cost line needs an id");
    if (ids.has(l.id)) throw new YieldCalculationError("duplicate_cost_line", `cost line ${l.id} appears twice`);
    ids.add(l.id);
    switch (l.completeness) {
      case "unknown":
        // A missing value is unknown, never zero (plan §3.7).
        throw new YieldCalculationError("unknown_cost", `cost line ${l.id} has an unknown amount`);
      case "zero":
        if (l.amount !== 0n) throw new YieldCalculationError("invalid_cost_line", `cost line ${l.id} is marked zero but its amount is not 0`);
        break;
      case "estimated":
        if (!allowEstimated) throw new YieldCalculationError("estimated_cost_not_allowed", `cost line ${l.id} is an estimate, which the policy does not allow`);
        estimated.push(l.id);
        assertNonNegative(`cost line ${l.id}`, l.amount);
        break;
      case "known":
        assertNonNegative(`cost line ${l.id}`, l.amount);
        break;
      default:
        throw new YieldCalculationError("invalid_cost_line", `cost line ${l.id} has no valid completeness`);
    }
    total += l.amount as bigint;
  }
  return { total, estimated: estimated.sort() };
}

function feeFor(f: FeePolicy, r: { netRevenue: bigint; operatingResult: bigint; afterLosses: bigint; afterReserves: bigint }): { fee: bigint; base: bigint | null; dropped: bigint; droppedCap: bigint } {
  const loss = r.operatingResult <= 0n;
  let fee = 0n;
  let base: bigint | null = null;
  let dropped = 0n;
  let droppedCap = 0n;
  let payable: boolean;
  switch (f.alternative) {
    case "F1":
      base = r.netRevenue;
      payable = (!loss || f.chargeInLossCycle) && base > 0n;
      break;
    case "F2":
      base = r.afterLosses;
      payable = base > 0n;
      break;
    case "F3":
      base = r.afterReserves;
      payable = base > 0n;
      break;
    case "F4":
      payable = !loss || f.chargeInLossCycle;
      break;
  }
  if (!payable) return { fee: 0n, base, dropped: 0n, droppedCap: 0n };
  if (f.alternative === "F4") {
    if (f.schedule.kind === "fixed") fee = f.schedule.amount;
    else {
      const tier = [...f.schedule.tiers].reverse().find((t) => t.fromNetRevenue <= r.netRevenue);
      if (!tier) throw new YieldCalculationError("no_fee_tier", "no fee tier applies to this net revenue");
      fee = tier.amount;
    }
    if (f.capBasisPointsOfNetRevenue !== null) {
      const c = applyBasisPoints(max(r.netRevenue, 0n), f.capBasisPointsOfNetRevenue);
      if (fee > c.value) {
        fee = c.value;
        droppedCap = c.droppedNumerator;
      }
    }
  } else {
    const a = applyBasisPoints(base as bigint, f.basisPoints);
    fee = a.value;
    dropped = a.droppedNumerator;
  }
  if (f.minimum !== null) fee = max(fee, f.minimum);
  if (f.maximum !== null) fee = min(fee, f.maximum);
  return { fee, base, dropped, droppedCap };
}

/**
 * Computes the waterfall. The policy must be usable for the cycle: a real cycle needs an `approved`
 * policy, a simulation cycle a `simulation` one.
 */
export function calculateYieldWaterfall(cycle: { simulation: boolean }, policy: YieldCalculationPolicy, inputs: WaterfallInputs): WaterfallResult {
  assertYieldPolicy(policy);
  assertYieldRecordUsable(cycle, { status: policy.status, kind: "calculation policy" });
  assertExactKeys("inputs", inputs, INPUT_KEYS);
  for (const k of ["grossRevenue", "refunds", "chargebacks", "rebates", "taxesCollected", "lossCarriedForward", "approvedReserveReleases"] as const) assertNonNegative(k, inputs?.[k]);

  const netRevenue = inputs.grossRevenue - inputs.refunds - inputs.chargebacks - inputs.rebates - inputs.taxesCollected;
  const { total: operatingExpensesTotal, estimated } = operatingExpenses(inputs.expenses, policy.allowEstimatedCosts);
  const operatingResult = netRevenue - operatingExpensesTotal;
  const lossCycle = operatingResult <= 0n;

  if (!policy.lossCarryForward.enabled && inputs.lossCarriedForward !== 0n)
    throw new YieldCalculationError("carry_forward_disabled", "a loss carried forward was supplied, but the policy does not carry losses forward");
  if (lossCycle && inputs.approvedReserveReleases !== 0n)
    throw new YieldCalculationError("release_in_loss_cycle", "reserve releases into a loss cycle are not allowed until decided (D-7)");

  const lossCarriedForwardUsed = policy.lossCarryForward.enabled ? min(max(operatingResult, 0n), inputs.lossCarriedForward) : 0n;
  const resultAfterLosses = operatingResult - lossCarriedForwardUsed;

  let maintenanceReserve = 0n;
  let riskReserve = 0n;
  let droppedM = 0n;
  let droppedI = 0n;
  if (resultAfterLosses > 0n) {
    const m = applyBasisPoints(resultAfterLosses, policy.reserves.maintenanceBasisPoints);
    const i = applyBasisPoints(resultAfterLosses, policy.reserves.riskBasisPoints);
    maintenanceReserve = cap(m.value, policy.reserves.maintenanceCap);
    riskReserve = cap(i.value, policy.reserves.riskCap);
    droppedM = maintenanceReserve === m.value ? m.droppedNumerator : 0n;
    droppedI = riskReserve === i.value ? i.droppedNumerator : 0n;
  }

  const fee = feeFor(policy.fee, { netRevenue, operatingResult, afterLosses: resultAfterLosses, afterReserves: resultAfterLosses - maintenanceReserve - riskReserve });
  const raw = resultAfterLosses - maintenanceReserve - riskReserve - fee.fee + inputs.approvedReserveReleases;
  const loss = max(-operatingResult, 0n);
  const netDistributableYield = max(raw, 0n);
  // What the result does not cover beyond the loss itself (e.g. a fee charged in a loss cycle, or a fee
  // minimum larger than the result). Reported, never absorbed.
  const shortfall = max(-raw, 0n) - loss;
  if (shortfall < 0n) throw new YieldAmountError("invalid_parameter", "internal: negative shortfall");

  return {
    netRevenue,
    operatingExpenses: operatingExpensesTotal,
    operatingResult,
    lossCarriedForwardUsed,
    resultAfterLosses,
    maintenanceReserve,
    riskReserve,
    fee: fee.fee,
    feeBase: fee.base,
    approvedReserveReleases: inputs.approvedReserveReleases,
    netDistributableYield,
    loss,
    shortfall,
    estimatedCostLines: estimated,
    droppedBasisPointNumerators: { maintenance: droppedM, risk: droppedI, fee: fee.dropped, feeCap: fee.droppedCap },
  };
}
