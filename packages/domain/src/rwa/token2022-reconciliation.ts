/**
 * Before a new attempt at a Token-2022 share-token action, after the last attempt expired: did the
 * expired attempt land after all?
 *
 * `expired` means that the transaction's blockhash can no longer land and that the node did not report
 * the signature. That is not proof that it never landed: an RPC node may have pruned the signature from
 * its history. A new mint after a pruned but landed one would issue the shares twice. Compressed NFTs
 * already check the tree before retrying (the leaf's position); this does the same for share tokens,
 * from what the chain says now:
 *
 *   - the attempt's signature status at `finalized`, with history search;
 *   - the mint's finalized supply, against the supply the platform's own confirmed records lead it to
 *     expect before this action;
 *   - the target token account's finalized balance (mint, burn) or frozen state (freeze, thaw),
 *     against the expected value before this action.
 *
 * A new attempt is allowed only when every piece of evidence says the action did not happen. If the
 * evidence says it happened exactly, the attempt landed: no retry, and a person reconciles. Anything
 * else (a partial change, an unexplained difference, missing evidence) holds the intent.
 *
 * Owner decision (2026-10-21): this is offline, pure decision logic with fixtures and tests. It is not
 * wired into the execution engine, reads nothing from a chain, and never submits, signs or retries.
 * TRON is out of scope under the current holds.
 */
import type { OperationState } from "./lifecycle";
import { outcomeUnknown } from "./lifecycle";
import type { IssuanceAction } from "./model";

export interface ShareTokenIntent {
  action: IssuanceAction;
  /** Base units; positive for mint and burn, ignored for freeze and thaw. */
  amount: bigint;
}

export interface LastAttempt {
  state: OperationState;
  attempt: number;
  /** The blockhash validity limit of the attempt's transaction; null if it was never prepared. */
  lastValidBlockHeight: bigint | null;
}

/** Expected (from the platform's confirmed records, before this action) against observed (finalized). */
export interface Compared<T> {
  expected: T;
  observed: T;
}

export interface Token2022Evidence {
  finalizedBlockHeight: bigint;
  /**
   * The attempt's signature at `finalized` with history search: `succeeded` or `failed` when found,
   * `not_found` when the node has no record of it, `unavailable` when it could not be asked.
   */
  signature: "succeeded" | "failed" | "not_found" | "unavailable";
  /** Other operations on this mint whose outcome is not settled; their effects cannot be told apart. */
  otherUnsettledOnMint: number;
  supply: Compared<bigint> | null;
  /** The target account's balance (mint, burn). */
  balance: Compared<bigint> | null;
  /** The target account's frozen state (freeze, thaw). */
  frozen: Compared<boolean> | null;
}

export type RetryDecision =
  | { kind: "retry"; basis: "signature_not_found" | "signature_failed" }
  | { kind: "wait"; reason: "outcome_unknown" | "could_still_land" | "other_attempts_in_flight" | "evidence_unavailable" }
  | { kind: "landed"; basis: "signature_succeeded" | "state_changed_exactly" }
  | { kind: "reconcile"; reason: "unexplained_change" | "signature_succeeded_but_state_unchanged" | "invalid_intent"; detail: string }
  | { kind: "not_applicable"; reason: "not_expired" };

/** What the chain must show if the action happened: the change in supply and balance, or the frozen state. */
function effectOf(intent: ShareTokenIntent): { supply: bigint; balance: bigint } | { frozen: boolean } {
  switch (intent.action) {
    case "mint":
      return { supply: intent.amount, balance: intent.amount };
    case "burn":
      return { supply: -intent.amount, balance: -intent.amount };
    case "freeze":
      return { frozen: true };
    case "thaw":
      return { frozen: false };
  }
}

/** Whether the action is visible on chain: "none", "exact", or "other" (anything else). */
function observedEffect(intent: ShareTokenIntent, ev: Token2022Evidence): "none" | "exact" | "other" | "missing" {
  const effect = effectOf(intent);
  if ("frozen" in effect) {
    if (!ev.frozen) return "missing";
    if (ev.frozen.expected === effect.frozen) return "other"; // already in the target state before: the records disagree
    if (ev.frozen.observed === ev.frozen.expected) return "none";
    return ev.frozen.observed === effect.frozen ? "exact" : "other";
  }
  if (!ev.supply || !ev.balance) return "missing";
  const dSupply = ev.supply.observed - ev.supply.expected;
  const dBalance = ev.balance.observed - ev.balance.expected;
  if (dSupply === 0n && dBalance === 0n) return "none";
  if (dSupply === effect.supply && dBalance === effect.balance) return "exact";
  return "other";
}

export function decideToken2022Retry(intent: ShareTokenIntent, last: LastAttempt, ev: Token2022Evidence): RetryDecision {
  if (outcomeUnknown(last.state)) return { kind: "wait", reason: "outcome_unknown" };
  if (last.state !== "expired") return { kind: "not_applicable", reason: "not_expired" };
  if ((intent.action === "mint" || intent.action === "burn") && intent.amount <= 0n)
    return { kind: "reconcile", reason: "invalid_intent", detail: `a ${intent.action} needs a positive amount` };
  // The blockhash must be past its limit at finalized; until then the transaction could still land.
  if (last.lastValidBlockHeight === null || ev.finalizedBlockHeight <= last.lastValidBlockHeight) return { kind: "wait", reason: "could_still_land" };
  if (ev.otherUnsettledOnMint > 0) return { kind: "wait", reason: "other_attempts_in_flight" };
  if (ev.signature === "unavailable") return { kind: "wait", reason: "evidence_unavailable" };

  const seen = observedEffect(intent, ev);
  if (seen === "missing") return { kind: "wait", reason: "evidence_unavailable" };

  if (ev.signature === "succeeded") {
    if (seen === "exact") return { kind: "landed", basis: "signature_succeeded" };
    return seen === "none"
      ? { kind: "reconcile", reason: "signature_succeeded_but_state_unchanged", detail: "the transaction succeeded but the chain shows no change from it" }
      : { kind: "reconcile", reason: "unexplained_change", detail: "the transaction succeeded but the chain changed by something other than this action" };
  }
  // Not found (perhaps pruned) or failed on chain: only the state can tell.
  if (seen === "exact") return { kind: "landed", basis: "state_changed_exactly" };
  if (seen === "other") return { kind: "reconcile", reason: "unexplained_change", detail: "the chain differs from the platform's records by something other than this action" };
  return { kind: "retry", basis: ev.signature === "failed" ? "signature_failed" : "signature_not_found" };
}
