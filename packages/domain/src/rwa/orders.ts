/**
 * Orders tie the two rails together. A subscription is paid on TRON and then issued on Solana;
 * a redemption is burned on Solana and then paid out on TRON; a distribution is paid out only.
 * There is no cross-chain atomicity, so the second leg only starts once the first is final,
 * and reconciliation reports whatever does not add up.
 */
import type { IntentStatus, IssuanceAction, ReconciliationKind, SettlementPurpose } from "./model";

export const ORDER_KINDS = ["subscription", "redemption", "distribution"] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

export const ORDER_STATUSES = ["open", "settling", "issuing", "completed", "cancelled", "exception"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderView {
  kind: OrderKind;
  /** Shares in base units (none for a distribution). */
  shareAmount: bigint | null;
  /** Stablecoin in base units. */
  settlementAmount: bigint;
  createdAt: Date;
}

export interface IntentView {
  side: "issuance" | "settlement";
  action?: IssuanceAction;
  purpose?: SettlementPurpose;
  /** Requested amount. */
  amount: bigint | null;
  /** Amount actually seen on chain, when the observer could read it. */
  observedAmount?: bigint;
  status: IntentStatus;
  completedAt?: Date;
  /** Chain operations of this intent that reached confirmed or later. */
  confirmedOperations: number;
}

/** Which intents an order of this kind is made of, in the order they must complete. */
export const ORDER_LEGS: Record<OrderKind, { first: Leg; second: Leg | null }> = {
  subscription: { first: { side: "settlement", purpose: "subscription" }, second: { side: "issuance", action: "mint" } },
  redemption: { first: { side: "issuance", action: "burn" }, second: { side: "settlement", purpose: "redemption" } },
  distribution: { first: { side: "settlement", purpose: "distribution" }, second: null },
};
type Leg = { side: "issuance"; action: IssuanceAction } | { side: "settlement"; purpose: SettlementPurpose };

const matches = (i: IntentView, leg: Leg) => i.side === leg.side && (leg.side === "issuance" ? i.action === leg.action : i.purpose === leg.purpose);
const done = (i: IntentView) => i.status === "completed";
const ended = (s: IntentStatus) => s === "cancelled" || s === "failed" || s === "policy_rejected";
const expectedOf = (o: OrderView, leg: Leg) => (leg.side === "settlement" ? o.settlementAmount : o.shareAmount);

/** Whether the second leg may start: the first has completed exactly once, for the expected amount. */
export function secondLegMayStart(order: OrderView, intents: IntentView[]): boolean {
  const legs = ORDER_LEGS[order.kind];
  if (!legs.second) return false;
  const first = intents.filter((i) => matches(i, legs.first) && done(i));
  if (first.length !== 1) return false;
  const got = first[0]!.observedAmount ?? first[0]!.amount;
  return got === expectedOf(order, legs.first) && !intents.some((i) => matches(i, legs.second!) && !ended(i.status));
}

export interface Discrepancy {
  kind: ReconciliationKind;
  expected: Record<string, string | number | null>;
  observed: Record<string, string | number | null>;
}

/**
 * What does not add up for one order. `slaMinutes` is how long the second leg may lag the first
 * (and how long an order may sit with nothing done) before it is reported.
 */
export function reconcileOrder(order: OrderView, intents: IntentView[], now: Date, slaMinutes: number): Discrepancy[] {
  const out: Discrepancy[] = [];
  const s = (n: bigint | null | undefined) => (n === null || n === undefined ? null : n.toString());
  const late = (t: Date) => now.getTime() - t.getTime() > slaMinutes * 60_000;
  const legs = ORDER_LEGS[order.kind];

  for (const leg of [legs.first, legs.second].filter((l): l is Leg => l !== null)) {
    const completed = intents.filter((i) => matches(i, leg) && done(i));
    const label = leg.side === "issuance" ? leg.action : leg.purpose;
    if (completed.length > 1) out.push({ kind: "duplicate", expected: { leg: label, completed: 1 }, observed: { leg: label, completed: completed.length } });
    const expected = expectedOf(order, leg);
    for (const c of completed) {
      const got = c.observedAmount ?? c.amount;
      if (expected !== null && got !== expected) out.push({ kind: "amount_mismatch", expected: { leg: label, amount: s(expected) }, observed: { leg: label, amount: s(got) } });
    }
  }

  // A chain transaction confirmed for an intent that is no longer wanted.
  for (const i of intents) {
    if (ended(i.status) && i.confirmedOperations > 0) {
      out.push({ kind: "orphan_chain_tx", expected: { status: i.status }, observed: { confirmedOperations: i.confirmedOperations } });
    }
  }

  const firstDone = intents.filter((i) => matches(i, legs.first) && done(i));
  if (legs.second) {
    const secondDone = intents.filter((i) => matches(i, legs.second!) && done(i));
    const missing: ReconciliationKind = legs.second.side === "issuance" ? "missing_issuance" : "missing_settlement";
    const missingFirst: ReconciliationKind = legs.first.side === "issuance" ? "missing_issuance" : "missing_settlement";
    // The second leg ran without the first: it must never happen, so it is always reported.
    if (secondDone.length > 0 && firstDone.length === 0) out.push({ kind: missingFirst, expected: { completedBefore: "first leg" }, observed: { firstLegCompleted: 0 } });
    const firstAt = firstDone[0]?.completedAt;
    if (firstDone.length > 0 && secondDone.length === 0 && firstAt && late(firstAt)) {
      out.push({ kind: missing, expected: { withinMinutes: slaMinutes }, observed: { firstLegCompletedAt: firstAt.toISOString() } });
    }
  }
  if (intents.every((i) => !done(i)) && late(order.createdAt)) out.push({ kind: "stale", expected: { withinMinutes: slaMinutes }, observed: { completed: 0 } });
  return out;
}
