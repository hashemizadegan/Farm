/**
 * Canonical calculation artifacts and their SHA-256 (plan revision 4, §3.8). The canonical form is the
 * repository's `canonicalJson` (sorted keys, no whitespace) over a value in which every `bigint` is a
 * decimal string. Floating-point numbers are refused, so an artifact can never carry a float amount.
 */
import { canonicalJson } from "../harvest";
import { YieldAmountError } from "./amounts";
import type { ConversionResult, RationalRate } from "./fx";
import type { YieldCalculationPolicy } from "./policy";
import type { WaterfallInputs, WaterfallResult } from "./waterfall";

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

/** The calculation artifact: everything needed to reproduce the result, in one canonical object. */
export function buildCalculationArtifact(a: CalculationArtifactInput) {
  return {
    scheme: YIELD_CALCULATION_ARTIFACT_SCHEME,
    cycle: a.cycle,
    policy: a.policy,
    inputs: a.inputs,
    result: a.result,
    settlement: a.settlement,
  };
}
