/**
 * Splitting an amount in proportion to integer weights (plan revision 4, §3.2). Where the weights come
 * from (verified ownership, Y5) is not this module's concern.
 *
 * - Each share is floor(total × weight / Σ weights).
 * - The **remainder** (total − Σ floors) follows an explicit rule (D-9):
 *   - `largest_remainder`: one unit each to the largest dropped fractions, ties broken by ascending
 *     recipient bytes;
 *   - `carry`: nothing more is allocated, and the remainder is returned for the caller to carry.
 * - **Dust**: an allocation below the explicit threshold stays allocated to its recipient but is marked
 *   `deferred` (its payment is deferred). It never flows back into the remainder or to anyone else.
 * - Every allocation must fit u64; otherwise the split fails with `amount_out_of_range`.
 */
import { YieldAmountError, assertExactKeys, assertNonNegative, assertU64 } from "./amounts";

export const REMAINDER_RULES = ["largest_remainder", "carry"] as const;
export type RemainderRule = (typeof REMAINDER_RULES)[number];

export interface SplitPolicy {
  remainder: RemainderRule;
  /** Allocations strictly below this are marked deferred. 0n marks nothing; there is no default. */
  dustThreshold: bigint;
}

export interface SplitWeight {
  /** The recipient's bytes as lowercase hex (even length, at least one byte). */
  recipient: string;
  weight: bigint;
}

export interface SplitAllocation {
  recipient: string;
  amount: bigint;
  deferred: boolean;
}

export interface SplitResult {
  /** In canonical order: ascending recipient bytes. */
  allocations: SplitAllocation[];
  /** Units not allocated (always 0 with `largest_remainder`). */
  remainder: bigint;
}

const HEX = /^(?:[0-9a-f]{2})+$/;

/** Byte-wise comparison of two lowercase hex strings; a prefix sorts first. */
export function compareRecipientBytes(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 2) {
    const x = parseInt(a.slice(i, i + 2), 16);
    const y = parseInt(b.slice(i, i + 2), 16);
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}

export function splitProportionally(total: bigint, weights: readonly SplitWeight[], policy: SplitPolicy): SplitResult {
  assertNonNegative("total", total);
  if (policy && typeof policy === "object") assertExactKeys("split policy", policy, ["remainder", "dustThreshold"]);
  if (!policy || !(REMAINDER_RULES as readonly string[]).includes(policy.remainder)) throw new YieldAmountError("invalid_parameter", "the remainder rule must be given explicitly");
  assertNonNegative("dustThreshold", policy.dustThreshold);
  if (!Array.isArray(weights) || weights.length === 0) throw new YieldAmountError("invalid_parameter", "at least one weight is required");

  const seen = new Set<string>();
  let sum = 0n;
  for (const w of weights) {
    assertExactKeys("weight", w, ["recipient", "weight"]);
    if (typeof w.recipient !== "string" || !HEX.test(w.recipient)) throw new YieldAmountError("invalid_parameter", "a recipient must be lowercase hex bytes");
    if (seen.has(w.recipient)) throw new YieldAmountError("invalid_parameter", `recipient ${w.recipient} appears twice`);
    seen.add(w.recipient);
    assertNonNegative(`weight of ${w.recipient}`, w.weight);
    sum += w.weight;
  }
  if (sum === 0n) throw new YieldAmountError("invalid_parameter", "the weights add up to zero");

  const ordered = [...weights].sort((a, b) => compareRecipientBytes(a.recipient, b.recipient));
  const parts = ordered.map((w) => {
    const n = total * w.weight;
    return { recipient: w.recipient, amount: n / sum, fraction: n % sum };
  });
  let remainder = total - parts.reduce((s, p) => s + p.amount, 0n);

  if (policy.remainder === "largest_remainder" && remainder > 0n) {
    // Largest fraction first; equal fractions in ascending recipient bytes (parts are already in that order,
    // and the sort is stable).
    const byFraction = [...parts].sort((a, b) => (a.fraction === b.fraction ? 0 : a.fraction > b.fraction ? -1 : 1));
    for (const p of byFraction) {
      if (remainder === 0n) break;
      p.amount += 1n;
      remainder -= 1n;
    }
  }

  const allocations = parts.map((p) => {
    assertU64(`allocation to ${p.recipient}`, p.amount);
    return { recipient: p.recipient, amount: p.amount, deferred: p.amount < policy.dustThreshold };
  });
  return { allocations, remainder };
}
