/**
 * Evidence aggregation and the reserve-offset ceiling estimate (track 2). Pure: no I/O, no clock.
 *
 * 1. `aggregateEvidence` turns monetary lines extracted from a cycle's evidence into the waterfall's inputs
 *    (Y2), in the policy's accounting currency, with full provenance. Every line must point at an item in
 *    the cycle's evidence manifest (Y3). Double counting is refused (plan §3.4: each evidence hash and
 *    each source reference backs at most one input), and so is a line backed by superseded evidence.
 *    Lines in another currency need a recorded rational rate; the dropped fraction of each conversion is
 *    reported. Which rate date applies is the policy's `conversionDateRule` (D-4), applied by the caller.
 *
 * 2. `estimateReserveOffsetCeiling` estimates the most a reserve **could** offset a cycle's loss. It is an
 *    estimate only: whether reserves may cover losses at all is D-7, and nothing here moves a reserve.
 *    The waterfall still refuses reserve releases in a loss cycle.
 *
 * Pending decisions are explicit record fields. Temporary defaults ship as `simulation` records only, so a
 * real cycle (which needs `approved` records) still fails closed.
 */
import { YieldAmountError, applyBasisPoints, assertBasisPoints, assertExactKeys, assertNonNegative } from "./amounts";
import { type EvidenceManifest, canonicalEvidenceManifest } from "./evidence";
import { type ConversionResult, type RationalRate, convertAmount } from "./fx";
import { type YieldCalculationPolicy, assertYieldPolicy } from "./policy";
import { YIELD_RECORD_STATUSES, assertYieldRecordUsable, type YieldRecordStatus } from "./records";
import { type CostCompleteness, type CostLine, type WaterfallInputs, type WaterfallResult, calculateYieldWaterfall } from "./waterfall";

// ── Evidence aggregation ───────────────────────────────────────────────────────────────────────────

export const EVIDENCE_LINE_CATEGORIES = ["gross_revenue", "refund", "chargeback", "rebate", "tax_collected", "operating_expense"] as const;
export type EvidenceLineCategory = (typeof EVIDENCE_LINE_CATEGORIES)[number];

export interface EvidenceLine {
  /** Unique within the cycle. Becomes the cost-line id for expenses. */
  lineId: string;
  /** The evidence item (in the cycle's manifest) this amount comes from. */
  evidenceSha256: string;
  category: EvidenceLineCategory;
  /** Minor units of `currency`; null only when `completeness` is `unknown` (expenses only). */
  amount: bigint | null;
  currency: { code: string; exponent: number };
  /** `known` for revenue-side lines; expenses may also be `zero`, `estimated` or `unknown` (plan §3.7). */
  completeness: CostCompleteness;
  /** Required when `currency` differs from the accounting currency; null when it is the same. */
  rate: RationalRate | null;
}

export interface AggregationProvenance {
  lineId: string;
  category: EvidenceLineCategory;
  evidenceSha256: string;
  sourceId: string;
  /** In accounting minor units; null for an unknown cost. */
  accountingAmount: bigint | null;
  conversion: ConversionResult | null;
}

export interface AggregationResult {
  inputs: WaterfallInputs;
  /** One entry per line, ordered by lineId (code units). */
  provenance: AggregationProvenance[];
}

export type AggregationErrorCode = "invalid_line" | "unknown_evidence" | "superseded_evidence" | "double_counted" | "currency_mismatch" | "rate_required" | "rate_not_allowed" | "manifest_mismatch";

export class AggregationError extends Error {
  constructor(
    readonly code: AggregationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AggregationError";
  }
}

const LINE_KEYS = ["lineId", "evidenceSha256", "category", "amount", "currency", "completeness", "rate"];
const FIELD: Record<Exclude<EvidenceLineCategory, "operating_expense">, keyof Pick<WaterfallInputs, "grossRevenue" | "refunds" | "chargebacks" | "rebates" | "taxesCollected">> = {
  gross_revenue: "grossRevenue",
  refund: "refunds",
  chargeback: "chargebacks",
  rebate: "rebates",
  tax_collected: "taxesCollected",
};
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "" && v.trim() === v;
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Aggregates evidence lines into waterfall inputs. `lossCarriedForward` and `approvedReserveReleases` do
 * not come from evidence: they are supplied from the cycle's ledger and approvals.
 */
export function aggregateEvidence(input: {
  cycle: { id: string; version: number; simulation: boolean };
  policy: YieldCalculationPolicy;
  manifest: EvidenceManifest;
  lines: readonly EvidenceLine[];
  lossCarriedForward: bigint;
  approvedReserveReleases: bigint;
}): AggregationResult {
  assertExactKeys("aggregation input", input, ["cycle", "policy", "manifest", "lines", "lossCarriedForward", "approvedReserveReleases"]);
  const { cycle, policy, manifest, lines } = input;
  assertYieldPolicy(policy);
  assertYieldRecordUsable(cycle, { status: policy.status, kind: "calculation policy" });
  canonicalEvidenceManifest(manifest); // validates the manifest in full
  if (manifest.cycleId !== cycle.id || manifest.cycleVersion !== cycle.version) throw new AggregationError("manifest_mismatch", "the manifest belongs to another cycle or version");
  assertNonNegative("lossCarriedForward", input.lossCarriedForward);
  assertNonNegative("approvedReserveReleases", input.approvedReserveReleases);
  if (!Array.isArray(lines)) throw new AggregationError("invalid_line", "lines must be a list");

  const items = new Map(manifest.items.map((i) => [i.contentSha256, i]));
  const superseded = new Set(manifest.items.map((i) => i.supersedes).filter((h): h is string => h !== null));
  const acct = policy.accountingCurrency;
  const lineIds = new Set<string>();
  const usedHashes = new Map<string, string>();
  const usedSources = new Map<string, string>();
  const totals = { grossRevenue: 0n, refunds: 0n, chargebacks: 0n, rebates: 0n, taxesCollected: 0n };
  const expenses: CostLine[] = [];
  const provenance: AggregationProvenance[] = [];

  for (const l of lines) {
    assertExactKeys("evidence line", l as unknown, LINE_KEYS);
    if (!nonEmpty(l.lineId)) throw new AggregationError("invalid_line", "every line needs a lineId");
    if (lineIds.has(l.lineId)) throw new AggregationError("invalid_line", `line ${l.lineId} appears twice`);
    lineIds.add(l.lineId);
    if (!(EVIDENCE_LINE_CATEGORIES as readonly unknown[]).includes(l.category)) throw new AggregationError("invalid_line", `line ${l.lineId} has an unknown category`);

    const item = items.get(l.evidenceSha256);
    if (!item) throw new AggregationError("unknown_evidence", `line ${l.lineId} points at evidence not in the manifest`);
    if (superseded.has(item.contentSha256)) throw new AggregationError("superseded_evidence", `line ${l.lineId} points at superseded evidence`);
    const prevByHash = usedHashes.get(item.contentSha256);
    if (prevByHash) throw new AggregationError("double_counted", `evidence ${item.contentSha256} backs lines ${prevByHash} and ${l.lineId}`);
    usedHashes.set(item.contentSha256, l.lineId);
    const prevBySource = usedSources.get(item.sourceId);
    if (prevBySource) throw new AggregationError("double_counted", `source ${item.sourceId} backs lines ${prevBySource} and ${l.lineId}`);
    usedSources.set(item.sourceId, l.lineId);

    if (l.category !== "operating_expense" && l.completeness !== "known") throw new AggregationError("invalid_line", `revenue-side line ${l.lineId} must be known`);
    if (l.completeness === "unknown") {
      if (l.amount !== null || l.rate !== null) throw new AggregationError("invalid_line", `unknown line ${l.lineId} has an amount or a rate`);
    } else assertNonNegative(`line ${l.lineId}`, l.amount);

    assertExactKeys(`currency of ${l.lineId}`, l.currency as unknown, ["code", "exponent"]);
    let accountingAmount: bigint | null = l.amount;
    let conversion: ConversionResult | null = null;
    if (l.currency.code === acct.code) {
      if (l.currency.exponent !== acct.exponent) throw new AggregationError("currency_mismatch", `line ${l.lineId} uses ${acct.code} with exponent ${l.currency.exponent}, not ${acct.exponent}`);
      if (l.rate !== null) throw new AggregationError("rate_not_allowed", `line ${l.lineId} is already in the accounting currency`);
    } else {
      if (!/^[A-Z]{3}$/.test(l.currency.code)) throw new AggregationError("invalid_line", `line ${l.lineId} has an invalid currency code`);
      if (l.completeness !== "unknown") {
        if (l.rate === null) throw new AggregationError("rate_required", `line ${l.lineId} in ${l.currency.code} needs a recorded rate`);
        conversion = convertAmount(l.amount as bigint, l.currency.exponent, acct.exponent, l.rate);
        accountingAmount = conversion.value;
      } else if (l.rate !== null) throw new AggregationError("invalid_line", `unknown line ${l.lineId} has a rate`);
    }

    if (l.category === "operating_expense") expenses.push({ id: l.lineId, amount: accountingAmount, completeness: l.completeness });
    else {
      const field: keyof typeof totals = FIELD[l.category as Exclude<EvidenceLineCategory, "operating_expense">];
      totals[field] += accountingAmount as bigint;
    }
    provenance.push({ lineId: l.lineId, category: l.category, evidenceSha256: item.contentSha256, sourceId: item.sourceId, accountingAmount, conversion });
  }

  expenses.sort((a, b) => byCodeUnits(a.id, b.id));
  provenance.sort((a, b) => byCodeUnits(a.lineId, b.lineId));
  return { inputs: { ...totals, expenses, lossCarriedForward: input.lossCarriedForward, approvedReserveReleases: input.approvedReserveReleases }, provenance };
}

/** Aggregates and runs the waterfall in one step. */
export function aggregateAndCalculate(input: Parameters<typeof aggregateEvidence>[0]): AggregationResult & { result: WaterfallResult } {
  const aggregated = aggregateEvidence(input);
  return { ...aggregated, result: calculateYieldWaterfall(input.cycle, input.policy, aggregated.inputs) };
}

// ── Reserve offset ceiling (estimate only; pending D-7) ───────────────────────────────────────────

export const OFFSETTING_RESERVES = ["maintenance", "risk"] as const;
export type OffsettingReserve = (typeof OFFSETTING_RESERVES)[number];

export interface ReserveOffsetPolicy {
  id: string;
  version: number;
  status: YieldRecordStatus;
  /** Which reserves may be counted towards an offset. Pending D-7. */
  eligibleReserves: readonly OffsettingReserve[];
  /** Cap as a share of the loss, in basis points. Pending D-7. */
  maxBasisPointsOfLoss: bigint;
  /** Cap as a share of the eligible balance, in basis points. Pending D-7. */
  maxBasisPointsOfBalance: bigint;
}

/**
 * Temporary defaults for **simulation cycles only** (status `simulation`); a real cycle refuses them.
 * Pending D-7: the risk (climate/insurance) reserve I is the candidate the plan names; no cap below 100%.
 */
export const SIMULATION_RESERVE_OFFSET_POLICY: ReserveOffsetPolicy = Object.freeze({
  id: "simulation-reserve-offset-defaults",
  version: 1,
  status: "simulation",
  eligibleReserves: Object.freeze(["risk"] as const), // pending D-7
  maxBasisPointsOfLoss: 10_000n, // pending D-7
  maxBasisPointsOfBalance: 10_000n, // pending D-7
});

export interface ReserveOffsetEstimate {
  /** The most the eligible reserves could offset, in accounting minor units (rounded down). */
  ceiling: bigint;
  eligibleBalance: bigint;
  lossCap: bigint;
  balanceCap: bigint;
  /** Which cap sets the ceiling; `none` when there is no loss or no eligible balance. */
  binding: "loss" | "balance" | "none";
  /** Always true: this moves no reserve and authorises no release. */
  estimateOnly: true;
}

/** Every problem with a reserve offset policy, or an empty list. */
export function reserveOffsetPolicyProblems(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["a reserve offset policy must be an object"];
  const o = v as Record<string, unknown>;
  const out: string[] = [];
  const extra = Object.keys(o).filter((k) => !["id", "version", "status", "eligibleReserves", "maxBasisPointsOfLoss", "maxBasisPointsOfBalance"].includes(k));
  if (extra.length) out.push(`reserve offset policy has unsupported keys: ${extra.sort().join(", ")}`);
  if (!nonEmpty(o.id)) out.push("id must be a non-empty string");
  if (!(typeof o.version === "number" && Number.isSafeInteger(o.version) && o.version >= 1)) out.push("version must be an integer ≥ 1");
  if (!(YIELD_RECORD_STATUSES as readonly unknown[]).includes(o.status)) out.push(`status must be one of ${YIELD_RECORD_STATUSES.join(", ")}`);
  const r = o.eligibleReserves;
  if (!Array.isArray(r) || !r.every((x) => (OFFSETTING_RESERVES as readonly unknown[]).includes(x)) || new Set(r).size !== r.length) out.push(`eligibleReserves must be a list of distinct values from ${OFFSETTING_RESERVES.join(", ")}`);
  for (const k of ["maxBasisPointsOfLoss", "maxBasisPointsOfBalance"]) {
    try {
      assertBasisPoints(k, o[k]);
    } catch (e) {
      out.push((e as Error).message);
    }
  }
  return out;
}

/** Estimates the reserve offset ceiling for a loss. Moves nothing. */
export function estimateReserveOffsetCeiling(input: {
  cycle: { simulation: boolean };
  policy: ReserveOffsetPolicy;
  /** The cycle's loss (the waterfall's `loss`), accounting minor units. */
  loss: bigint;
  /** Current reserve balances from the reserve ledger, accounting minor units. */
  balances: { maintenance: bigint; risk: bigint };
}): ReserveOffsetEstimate {
  assertExactKeys("estimate input", input, ["cycle", "policy", "loss", "balances"]);
  const problems = reserveOffsetPolicyProblems(input.policy);
  if (problems.length) throw new YieldAmountError("invalid_parameter", `invalid reserve offset policy: ${problems.join("; ")}`);
  assertYieldRecordUsable(input.cycle, { status: input.policy.status, kind: "reserve offset policy" });
  assertNonNegative("loss", input.loss);
  assertExactKeys("balances", input.balances as unknown, ["maintenance", "risk"]);
  for (const r of OFFSETTING_RESERVES) assertNonNegative(`${r} balance`, input.balances[r]);

  const eligibleBalance = input.policy.eligibleReserves.reduce((n, r) => n + input.balances[r], 0n);
  const lossCap = applyBasisPoints(input.loss, input.policy.maxBasisPointsOfLoss).value;
  const balanceCap = applyBasisPoints(eligibleBalance, input.policy.maxBasisPointsOfBalance).value;
  const ceiling = lossCap < balanceCap ? lossCap : balanceCap;
  const binding = ceiling === 0n && (input.loss === 0n || eligibleBalance === 0n) ? "none" : lossCap <= balanceCap ? "loss" : "balance";
  return { ceiling, eligibleBalance, lossCap, balanceCap, binding, estimateOnly: true };
}
