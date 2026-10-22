/**
 * Display helpers for the internal yield pages (Y10). Pure, so they are unit tested.
 *
 * The pages are for staff only, behind NEXT_PUBLIC_YIELD_PAGES_ENABLED (off by default; the build refuses it in
 * deployed environments until an approved disclosure version exists, D-39). They are read-only.
 */

/** Whether the internal yield pages are shown in this build. */
export const yieldPagesEnabled = (env: Record<string, string | undefined> = { NEXT_PUBLIC_YIELD_PAGES_ENABLED: process.env.NEXT_PUBLIC_YIELD_PAGES_ENABLED }) =>
  env.NEXT_PUBLIC_YIELD_PAGES_ENABLED === "true";

/** Refuses the flag in a deployed build (used by next.config.ts): no approved disclosure version exists (D-39). */
export function yieldPagesBuildProblem(env: Record<string, string | undefined>): string | null {
  if (env.NEXT_PUBLIC_YIELD_PAGES_ENABLED !== "true") return null;
  if (env.APP_ENV === "staging" || env.APP_ENV === "production") return "NEXT_PUBLIC_YIELD_PAGES_ENABLED is refused in deployed environments until a disclosure version is approved (D-39)";
  return null;
}

/** The plan's (§8) wording key for a cycle status; unknown statuses fall back to themselves. */
export function yieldStatusKey(status: string, closeReason?: string | null): string {
  if (status === "closed" && (closeReason === "no_distribution" || closeReason === "loss")) return `closed_${closeReason}`;
  return status;
}

type Tone = "ok" | "pending" | "problem" | "neutral";

export function yieldTone(status: string): Tone {
  if (status === "published" || status === "approved") return "ok";
  if (status === "disputed") return "problem";
  if (status === "closed" || status === "cancelled" || status === "abandoned" || status === "superseded") return "neutral";
  return "pending";
}

/** A 64-hex hash as its first and last characters; the full value stays available as a title. */
export const shortHash = (h: string | null | undefined, keep = 8) => (!h ? null : h.length <= keep * 2 + 1 ? h : `${h.slice(0, keep)}…${h.slice(-keep)}`);

/**
 * What a loaded query shows: `fresh` data, `stale` data (an earlier answer, the last refresh failed), an `error`
 * with nothing to show, `loading`, or `empty`.
 */
export function viewState<T>(q: { data?: T; error?: unknown; loading: boolean }, isEmpty: (d: T) => boolean): "loading" | "error" | "stale" | "empty" | "fresh" {
  if (q.data === undefined) return q.error ? "error" : "loading";
  if (q.error) return "stale";
  return isEmpty(q.data) ? "empty" : "fresh";
}

/** Decimal-string integers grouped by thousands, without floating point (amounts can exceed 2^53). */
export function groupDigits(value: string): string {
  if (!/^\d+$/.test(value)) return value;
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
