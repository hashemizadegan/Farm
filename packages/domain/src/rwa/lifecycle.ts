/**
 * Lifecycle of one chain operation (one attempt to land one transaction for an intent):
 *
 *   requested → policy_approved → prepared → submitted → observed → confirmed → business_completed
 *
 * "confirmed" means final on that rail: Solana `finalized` commitment, TRON solidified (19+ SR
 * confirmations). Side exits: policy_rejected (compliance said no), expired (never landed and can
 * no longer land: blockhash or TRON expiration passed), failed (landed with an error, or was
 * definitively refused). Only an expired attempt may be retried, as a new attempt; an attempt whose
 * outcome is unknown is never resent.
 */
export const OPERATION_STATES = [
  "requested",
  "policy_approved",
  "prepared",
  "submitted",
  "observed",
  "confirmed",
  "business_completed",
  "policy_rejected",
  "expired",
  "failed",
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

const NEXT: Record<OperationState, readonly OperationState[]> = {
  requested: ["policy_approved", "policy_rejected"],
  policy_approved: ["prepared", "failed"],
  prepared: ["submitted", "expired", "failed"],
  submitted: ["observed", "expired", "failed"],
  // Seen at a lower commitment, then dropped (fork) or executed with an error.
  observed: ["confirmed", "expired", "failed"],
  confirmed: ["business_completed"],
  business_completed: [],
  policy_rejected: [],
  expired: [],
  failed: [],
};

export const TERMINAL_STATES: readonly OperationState[] = OPERATION_STATES.filter((s) => NEXT[s].length === 0);

export function canTransition(from: OperationState, to: OperationState): boolean {
  return NEXT[from].includes(to);
}

export class TransitionError extends Error {
  constructor(
    public readonly from: OperationState,
    public readonly to: OperationState,
  ) {
    super(`chain operation cannot go from ${from} to ${to}`);
    this.name = "TransitionError";
  }
}

export function assertTransition(from: OperationState, to: OperationState): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}

/**
 * Whether a new attempt may be made after this one. Expired attempts provably never landed.
 * Anything submitted and not yet expired might still land, so retrying could double-spend.
 */
export function mayRetryAfter(state: OperationState): boolean {
  return state === "expired";
}

/** Whether the outcome on chain is unknown and must be observed before anything else happens. */
export function outcomeUnknown(state: OperationState): boolean {
  return state === "submitted" || state === "observed";
}

/** Pairs a transition table export for the database trigger (kept in sync by a test). */
export const TRANSITIONS: readonly (readonly [OperationState, OperationState])[] = OPERATION_STATES.flatMap((from) => NEXT[from].map((to) => [from, to] as const));
