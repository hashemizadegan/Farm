/**
 * Canonical calculation artifacts and their SHA-256 (plan revision 4, §3.8).
 *
 * Canonical form: the repository's `canonicalJson` (no whitespace; object keys sorted at every level by
 * `Array.prototype.sort`, i.e. UTF-16 code-unit order; keys whose value is `undefined` omitted) over a
 * value in which every `bigint` is a decimal string. Arrays keep their order, so every list in the
 * calculation artifact has a defined order: expense lines ascending by `id` (code-unit order), estimated
 * cost lines likewise, fee tiers ascending by threshold (enforced by the policy). Floating-point and
 * unsafe numbers are refused, so an artifact can never carry a float amount.
 */
import { canonicalJson } from "../harvest";
import { YieldAmountError, assertExactKeys } from "./amounts";
import { convertAmount, type ConversionResult, type RationalRate } from "./fx";
import type { YieldCalculationPolicy } from "./policy";
import { calculateYieldWaterfall, type WaterfallInputs, type WaterfallResult } from "./waterfall";

export const YIELD_CALCULATION_ARTIFACT_SCHEME = "metafarm-yield-calculation/1";

/** The value with bigints as decimal strings; refuses non-integer numbers, undefined in arrays, and non-plain objects. */
export function toCanonicalValue(v: unknown, path = "artifact"): unknown {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new YieldAmountError("invalid_parameter", `${path} is not a safe integer; amounts must be bigints`);
    return v;
  }
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((x, i) => {
    if (x === undefined) throw new YieldAmountError("invalid_parameter", `${path}[${i}] is undefined`);
    return toCanonicalValue(x, `${path}[${i}]`);
  });
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = toCanonicalValue(x, `${path}.${k}`);
    return out;
  }
  throw new YieldAmountError("invalid_parameter", `${path} cannot be put in a canonical artifact`);
}

export function canonicalYieldArtifact(v: unknown): string {
  return canonicalJson(toCanonicalValue(v));
}

/** SHA-256 (lowercase hex) of the canonical artifact. Web Crypto, as in harvest.ts. */
export async function yieldArtifactHash(v: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalYieldArtifact(v));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CalculationArtifactInput {
  cycle: { id: string; version: number; simulation: boolean };
  policy: YieldCalculationPolicy;
  inputs: WaterfallInputs;
  result: WaterfallResult;
  /** The final conversion into settlement base units (D-3, D-4), with the rate used. */
  settlement: { mint: string; network: string; decimals: number; rate: RationalRate; conversion: ConversionResult };
}

/**
 * The calculation artifact: everything needed to reproduce the result, in one canonical object.
 *
 * The supplied `result` and settlement `conversion` are recomputed from the cycle, policy, inputs and
 * rate, and the artifact is refused if either differs, so an artifact can never record numbers its own
 * inputs do not produce. The conversion is from the policy's accounting exponent to the settlement
 * decimals.
 */
export function buildCalculationArtifact(a: CalculationArtifactInput) {
  assertExactKeys("artifact input", a, ["cycle", "policy", "inputs", "result", "settlement"]);
  assertExactKeys("cycle", a.cycle, ["id", "version", "simulation"]);
  assertExactKeys("settlement", a.settlement, ["mint", "network", "decimals", "rate", "conversion"]);
  const result = calculateYieldWaterfall(a.cycle, a.policy, a.inputs);
  if (canonicalYieldArtifact(result) !== canonicalYieldArtifact(a.result)) throw new YieldAmountError("invalid_parameter", "the supplied result is not what the inputs and policy produce");
  const conversion = convertAmount(result.netDistributableYield, a.policy.accountingCurrency.exponent, a.settlement.decimals, a.settlement.rate);
  if (canonicalYieldArtifact(conversion) !== canonicalYieldArtifact(a.settlement.conversion)) throw new YieldAmountError("invalid_parameter", "the supplied settlement conversion is not what the result and rate produce");
  const expenses = [...a.inputs.expenses].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return {
    scheme: YIELD_CALCULATION_ARTIFACT_SCHEME,
    cycle: a.cycle,
    policy: a.policy,
    inputs: { ...a.inputs, expenses },
    result,
    settlement: { ...a.settlement, conversion },
  };
}
