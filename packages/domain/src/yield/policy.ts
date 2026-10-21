/**
 * The calculation policy record (plan revision 4, §3.3 and §3.8). Every value is explicit: the library
 * has **no defaults**, a missing value is an error, and "none" must be written as `null` where the type
 * allows it. Which values a real cycle uses is decided by approved policy records (D-1, D-2, D-4, D-5,
 * D-6, D-7, D-8, D-9, D-10, D-21), never by this code.
 */
import { BASIS_POINTS } from "./amounts";
import { assertExponent } from "./fx";
import { YIELD_RECORD_STATUSES, type YieldRecordStatus } from "./records";

export const YIELD_FORMULA_VERSIONS = ["yield-formula/1"] as const;
export type YieldFormulaVersion = (typeof YIELD_FORMULA_VERSIONS)[number];

/** Recorded with the cycle; the caller applies the rule when choosing rates (D-4). */
export const CONVERSION_DATE_RULES = ["transaction_date", "settlement_date", "evidence_date", "cycle_close"] as const;
export type ConversionDateRule = (typeof CONVERSION_DATE_RULES)[number];

/** Recorded with the cycle; the caller recognises revenue accordingly (D-5). */
export const RECOGNITION_BASES = ["cash", "accrual"] as const;
export type RecognitionBasis = (typeof RECOGNITION_BASES)[number];

export interface FeeLimits {
  /** Lowest fee when a fee is payable this cycle, or null for none. Accounting minor units. */
  minimum: bigint | null;
  /** Highest fee, or null for none. Accounting minor units. */
  maximum: bigint | null;
}

/** The fee alternatives of plan §3.3. None is a default; the policy must choose one (D-2). */
export type FeePolicy =
  | ({ alternative: "F1"; basisPoints: bigint; chargeInLossCycle: boolean } & FeeLimits)
  | ({ alternative: "F2"; basisPoints: bigint } & FeeLimits)
  | ({ alternative: "F3"; basisPoints: bigint } & FeeLimits)
  | ({
      alternative: "F4";
      schedule: { kind: "fixed"; amount: bigint } | { kind: "tiered"; tiers: readonly { fromNetRevenue: bigint; amount: bigint }[] };
      /** Cap as a share of net revenue, or null for none. */
      capBasisPointsOfNetRevenue: bigint | null;
      chargeInLossCycle: boolean;
    } & FeeLimits);

export interface YieldCalculationPolicy {
  id: string;
  version: number;
  status: YieldRecordStatus;
  formulaVersion: YieldFormulaVersion;
  /** The entitlement instrument the policy implements (D-1): id, version and SHA-256 of the document. */
  entitlement: { id: string; version: string; sha256: string };
  /** The single currency the waterfall is computed in (D-4). */
  accountingCurrency: { code: string; exponent: number };
  conversionDateRule: ConversionDateRule;
  recognitionBasis: RecognitionBasis;
  /** Whether losses carried forward are used (D-8). Expiry is applied by whoever supplies the amount. */
  lossCarryForward: { enabled: boolean };
  /** Reserve additions on the operating result after losses (D-6), each capped or null for none. */
  reserves: { maintenanceBasisPoints: bigint; maintenanceCap: bigint | null; riskBasisPoints: bigint; riskCap: bigint | null };
  fee: FeePolicy;
  /** Whether attested cost estimates may be used (D-21). */
  allowEstimatedCosts: boolean;
}

export class YieldPolicyError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid calculation policy: ${problems.join("; ")}`);
    this.name = "YieldPolicyError";
  }
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Every problem with a policy, or an empty list. Nothing is filled in. */
export function yieldPolicyProblems(p: unknown): string[] {
  const out: string[] = [];
  if (!p || typeof p !== "object") return ["a policy object is required"];
  const o = p as Record<string, unknown>;
  const str = (path: string, v: unknown) => (typeof v === "string" && v.trim() !== "" ? true : (out.push(`${path} must be a non-empty string`), false));
  const big = (path: string, v: unknown, min = 0n) => (typeof v === "bigint" && v >= min ? true : (out.push(`${path} must be a bigint ≥ ${min}`), false));
  const bps = (path: string, v: unknown) => (typeof v === "bigint" && v >= 0n && v <= BASIS_POINTS ? true : (out.push(`${path} must be 0–10000 basis points (bigint)`), false));
  const nullableBig = (obj: Record<string, unknown>, k: string, path: string) => {
    if (!has(obj, k)) return out.push(`${path} must be given (null for none)`);
    const v = obj[k];
    if (v !== null) big(path, v);
  };
  const bool = (path: string, v: unknown) => (typeof v === "boolean" ? true : (out.push(`${path} must be true or false`), false));
  const oneOf = (path: string, v: unknown, allowed: readonly string[]) => (typeof v === "string" && allowed.includes(v) ? true : (out.push(`${path} must be one of ${allowed.join(", ")}`), false));

  str("id", o.id);
  if (typeof o.version !== "number" || !Number.isInteger(o.version) || o.version < 1) out.push("version must be an integer ≥ 1");
  oneOf("status", o.status, YIELD_RECORD_STATUSES);
  oneOf("formulaVersion", o.formulaVersion, YIELD_FORMULA_VERSIONS);
  const ent = o.entitlement as Record<string, unknown> | undefined;
  if (!ent || typeof ent !== "object") out.push("entitlement is required");
  else {
    str("entitlement.id", ent.id);
    str("entitlement.version", ent.version);
    if (typeof ent.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(ent.sha256)) out.push("entitlement.sha256 must be 64 lowercase hex characters");
  }
  const cur = o.accountingCurrency as Record<string, unknown> | undefined;
  if (!cur || typeof cur !== "object") out.push("accountingCurrency is required");
  else {
    if (typeof cur.code !== "string" || !/^[A-Z]{3}$/.test(cur.code)) out.push("accountingCurrency.code must be an ISO 4217 code");
    try {
      assertExponent("accountingCurrency.exponent", cur.exponent);
    } catch (e) {
      out.push((e as Error).message);
    }
  }
  oneOf("conversionDateRule", o.conversionDateRule, CONVERSION_DATE_RULES);
  oneOf("recognitionBasis", o.recognitionBasis, RECOGNITION_BASES);
  const lcf = o.lossCarryForward as Record<string, unknown> | undefined;
  if (!lcf || typeof lcf !== "object") out.push("lossCarryForward is required");
  else bool("lossCarryForward.enabled", lcf.enabled);
  const r = o.reserves as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") out.push("reserves is required");
  else {
    const okM = bps("reserves.maintenanceBasisPoints", r.maintenanceBasisPoints);
    const okI = bps("reserves.riskBasisPoints", r.riskBasisPoints);
    nullableBig(r, "maintenanceCap", "reserves.maintenanceCap");
    nullableBig(r, "riskCap", "reserves.riskCap");
    if (okM && okI && (r.maintenanceBasisPoints as bigint) + (r.riskBasisPoints as bigint) > BASIS_POINTS) out.push("reserve basis points must not add up to more than 10000");
  }
  bool("allowEstimatedCosts", o.allowEstimatedCosts);

  const f = o.fee as Record<string, unknown> | undefined;
  if (!f || typeof f !== "object") out.push("fee is required");
  else if (!oneOf("fee.alternative", f.alternative, ["F1", "F2", "F3", "F4"])) {
    /* reported */
  } else {
    nullableBig(f, "minimum", "fee.minimum");
    nullableBig(f, "maximum", "fee.maximum");
    if (typeof f.minimum === "bigint" && typeof f.maximum === "bigint" && f.minimum > f.maximum) out.push("fee.minimum must not exceed fee.maximum");
    if (f.alternative === "F1" || f.alternative === "F2" || f.alternative === "F3") bps("fee.basisPoints", f.basisPoints);
    if (f.alternative === "F1" || f.alternative === "F4") bool("fee.chargeInLossCycle", f.chargeInLossCycle);
    if (f.alternative === "F4") {
      if (!has(f, "capBasisPointsOfNetRevenue")) out.push("fee.capBasisPointsOfNetRevenue must be given (null for none)");
      else if (f.capBasisPointsOfNetRevenue !== null) bps("fee.capBasisPointsOfNetRevenue", f.capBasisPointsOfNetRevenue);
      const s = f.schedule as Record<string, unknown> | undefined;
      if (!s || typeof s !== "object") out.push("fee.schedule is required");
      else if (s.kind === "fixed") big("fee.schedule.amount", s.amount);
      else if (s.kind === "tiered") {
        const tiers = s.tiers;
        if (!Array.isArray(tiers) || tiers.length === 0) out.push("fee.schedule.tiers must be a non-empty list");
        else {
          let prev: bigint | null = null;
          tiers.forEach((t: Record<string, unknown>, i: number) => {
            big(`fee.schedule.tiers[${i}].amount`, t?.amount);
            if (typeof t?.fromNetRevenue !== "bigint") out.push(`fee.schedule.tiers[${i}].fromNetRevenue must be a bigint`);
            else {
              if (prev !== null && t.fromNetRevenue <= prev) out.push("fee.schedule.tiers must be in strictly increasing fromNetRevenue order");
              prev = t.fromNetRevenue;
            }
          });
        }
      } else out.push("fee.schedule.kind must be fixed or tiered");
    }
  }
  return out;
}

export function assertYieldPolicy(p: unknown): asserts p is YieldCalculationPolicy {
  const problems = yieldPolicyProblems(p);
  if (problems.length) throw new YieldPolicyError(problems);
}
