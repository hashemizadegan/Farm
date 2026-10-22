/**
 * Integer amounts for yield calculations. Every monetary or allocation amount is a `bigint`: no floating
 * point anywhere. Claim leaves carry u64 amounts (plan revision 4, §6.2), so allocations are bounded to
 * u64; internal accounting may be wider (PostgreSQL `numeric(78,0)`).
 */

export const U64_MAX = (1n << 64n) - 1n;

/** Basis points in one whole (100%). */
export const BASIS_POINTS = 10_000n;

export type YieldAmountErrorCode = "not_integer" | "negative" | "amount_out_of_range" | "invalid_parameter";

export class YieldAmountError extends Error {
  constructor(
    readonly code: YieldAmountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "YieldAmountError";
  }
}

/** A `bigint` (never a number). */
export function assertInteger(name: string, v: unknown): asserts v is bigint {
  if (typeof v !== "bigint") throw new YieldAmountError("not_integer", `${name} must be a bigint, got ${typeof v}`);
}

export function assertNonNegative(name: string, v: unknown): asserts v is bigint {
  assertInteger(name, v);
  if (v < 0n) throw new YieldAmountError("negative", `${name} must not be negative`);
}

/** 0 ≤ v ≤ 2^64 − 1, else `amount_out_of_range`. */
export function assertU64(name: string, v: unknown): asserts v is bigint {
  assertInteger(name, v);
  if (v < 0n || v > U64_MAX) throw new YieldAmountError("amount_out_of_range", `${name} does not fit an unsigned 64-bit amount`);
}

/** Basis points in [0, 10000]. */
export function assertBasisPoints(name: string, v: unknown): asserts v is bigint {
  assertInteger(name, v);
  if (v < 0n || v > BASIS_POINTS) throw new YieldAmountError("invalid_parameter", `${name} must be between 0 and 10000 basis points`);
}

/**
 * A plain object with no keys outside `allowed`. An unsupported key is refused rather than ignored, so a
 * misspelt or unsupported parameter can never be silently dropped.
 */
export function assertExactKeys(name: string, v: unknown, allowed: readonly string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new YieldAmountError("invalid_parameter", `${name} must be an object`);
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new YieldAmountError("invalid_parameter", `${name} has unsupported keys: ${extra.sort().join(", ")}`);
}

/** floor(amount × bps / 10000) for amount ≥ 0, with the dropped remainder of the division. */
export function applyBasisPoints(amount: bigint, bps: bigint): { value: bigint; droppedNumerator: bigint } {
  if (amount < 0n) throw new YieldAmountError("negative", "basis points apply to a non-negative amount");
  const n = amount * bps;
  return { value: n / BASIS_POINTS, droppedNumerator: n % BASIS_POINTS };
}
