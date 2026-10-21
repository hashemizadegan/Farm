/**
 * Currency conversion with rational rates (plan revision 4, §3.2). Which rate applies to a line (its
 * transaction, settlement or evidence date, or cycle close) and which sources are approved are open
 * decisions (D-4): the caller supplies the rate, with its source and timestamp, and this module only
 * applies it. Rounds down, and returns the dropped fraction so nothing is silently lost.
 */
import { YieldAmountError, assertExactKeys, assertNonNegative } from "./amounts";

export interface RationalRate {
  /** Units of the target currency per unit of the source currency = num / den. */
  num: bigint;
  den: bigint;
  /** Identifier of the rate's source; required, never assumed. */
  source: string;
  /** When the rate was observed, RFC 3339 with an offset (e.g. `2026-09-30T16:00:00Z`). */
  observedAt: string;
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * RFC 3339 with an explicit offset, naming a real calendar date and time. `Date.parse` alone rolls
 * impossible values forward (2026-02-30 becomes 2026-03-02, 24:00 the next day), so the fields are checked.
 */
function isRfc3339WithOffset(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = RFC3339.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  // Proleptic Gregorian, computed directly: Date.UTC maps years 0–99 to 1900–1999.
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysInMonth = mo >= 1 && mo <= 12 ? ([31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] as number) : 0;
  if (d < 1 || d > daysInMonth || h > 23 || mi > 59 || sec > 59) return false;
  if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return false;
  return !Number.isNaN(Date.parse(v));
}
const MAX_EXPONENT = 30;

export function assertRationalRate(r: RationalRate): void {
  if (!r || typeof r !== "object") throw new YieldAmountError("invalid_parameter", "a rate is required");
  assertExactKeys("rate", r, ["num", "den", "source", "observedAt"]);
  if (typeof r.num !== "bigint" || typeof r.den !== "bigint" || r.num <= 0n || r.den <= 0n) throw new YieldAmountError("invalid_parameter", "a rate needs positive bigint num and den");
  if (typeof r.source !== "string" || r.source.trim() === "") throw new YieldAmountError("invalid_parameter", "a rate needs its source");
  if (!isRfc3339WithOffset(r.observedAt)) throw new YieldAmountError("invalid_parameter", "a rate needs an RFC 3339 observation time with an offset");
}

export function assertExponent(name: string, e: unknown): asserts e is number {
  if (typeof e !== "number" || !Number.isInteger(e) || e < 0 || e > MAX_EXPONENT) throw new YieldAmountError("invalid_parameter", `${name} must be an integer between 0 and ${MAX_EXPONENT}`);
}

export interface ConversionResult {
  value: bigint;
  /** value + droppedNumerator / denominator is the exact result. */
  droppedNumerator: bigint;
  denominator: bigint;
}

/**
 * Converts `amount` smallest units with `fromExponent` decimals into smallest units with `toExponent`
 * decimals at `rate`: floor(amount × num × 10^toExponent / (den × 10^fromExponent)).
 *
 * Used for a line in another currency into the accounting currency (minor units), and for the final
 * accounting amount into settlement-token base units (`toExponent` = the token's decimals).
 */
export function convertAmount(amount: bigint, fromExponent: number, toExponent: number, rate: RationalRate): ConversionResult {
  assertNonNegative("amount", amount);
  assertExponent("fromExponent", fromExponent);
  assertExponent("toExponent", toExponent);
  assertRationalRate(rate);
  const numerator = amount * rate.num * 10n ** BigInt(toExponent);
  const denominator = rate.den * 10n ** BigInt(fromExponent);
  return { value: numerator / denominator, droppedNumerator: numerator % denominator, denominator };
}
