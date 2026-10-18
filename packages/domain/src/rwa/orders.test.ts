import { describe, expect, it } from "vitest";
import { firstLegMayStart, legNeedsAttention, reconcileOrder, secondLegMayStart, type IntentView, type OrderView } from "./orders";

const now = new Date("2026-10-18T09:00:00Z");
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);
const sub: OrderView = { kind: "subscription", shareAmount: 1_000_000n, settlementAmount: 50_000_000n, createdAt: minutesAgo(120) };
const pay = (o: Partial<IntentView> = {}): IntentView => ({ side: "settlement", purpose: "subscription", amount: 50_000_000n, status: "completed", completedAt: minutesAgo(90), confirmedOperations: 1, ...o });
const mint = (o: Partial<IntentView> = {}): IntentView => ({ side: "issuance", action: "mint", amount: 1_000_000n, status: "completed", completedAt: minutesAgo(80), confirmedOperations: 1, ...o });
const kinds = (o: OrderView, i: IntentView[]) => reconcileOrder(o, i, now, 30).map((d) => d.kind);

describe("order legs", () => {
  it("issues only after exactly one payment of the right amount has completed", () => {
    expect(secondLegMayStart(sub, [])).toBe(false);
    expect(secondLegMayStart(sub, [pay({ status: "in_progress" })])).toBe(false);
    expect(secondLegMayStart(sub, [pay()])).toBe(true);
    expect(secondLegMayStart(sub, [pay({ observedAmount: 49_000_000n })])).toBe(false);
    expect(secondLegMayStart(sub, [pay(), pay()])).toBe(false);
    // Not twice: an issuance already under way blocks another.
    expect(secondLegMayStart(sub, [pay(), mint({ status: "in_progress" })])).toBe(false);
    expect(secondLegMayStart(sub, [pay(), mint({ status: "failed", confirmedOperations: 0 })])).toBe(true);
    expect(secondLegMayStart({ ...sub, kind: "distribution", shareAmount: null }, [pay({ purpose: "distribution" })])).toBe(false);
  });

  it("burns before paying out a redemption", () => {
    const red: OrderView = { ...sub, kind: "redemption" };
    expect(secondLegMayStart(red, [mint({ action: "burn" })])).toBe(true);
    expect(secondLegMayStart(red, [pay({ purpose: "redemption" })])).toBe(false);
  });
});

describe("reconciliation", () => {
  it("finds nothing wrong with a clean subscription", () => {
    expect(kinds(sub, [pay(), mint()])).toEqual([]);
  });

  it("reports wrong amounts and duplicates", () => {
    expect(kinds(sub, [pay({ observedAmount: 49_999_999n }), mint()])).toEqual(["amount_mismatch"]);
    expect(kinds(sub, [pay(), pay(), mint()])).toEqual(["duplicate"]);
    expect(kinds(sub, [pay(), mint({ amount: 2_000_000n })])).toEqual(["amount_mismatch"]);
  });

  it("reports a payment left without issuance past the deadline, but not before", () => {
    expect(kinds(sub, [pay()])).toEqual(["missing_issuance"]);
    expect(kinds(sub, [pay({ completedAt: minutesAgo(10) })])).toEqual([]);
  });

  it("always reports issuance without payment", () => {
    expect(kinds(sub, [mint()])).toEqual(["missing_settlement"]);
  });

  it("reports chain transactions for abandoned intents, and stale orders", () => {
    expect(kinds(sub, [pay({ status: "cancelled", confirmedOperations: 1 })])).toEqual(["orphan_chain_tx", "stale"]);
    expect(kinds(sub, [])).toEqual(["stale"]);
    expect(kinds({ ...sub, createdAt: minutesAgo(5) }, [])).toEqual([]);
  });

  it("checks a redemption the other way round", () => {
    const red: OrderView = { ...sub, kind: "redemption" };
    expect(kinds(red, [mint({ action: "burn" })])).toEqual(["missing_settlement"]);
    expect(kinds(red, [pay({ purpose: "redemption" })])).toEqual(["missing_issuance"]);
    expect(kinds(red, [mint({ action: "burn" }), pay({ purpose: "redemption" })])).toEqual([]);
  });
});

describe("starting and stopping legs", () => {
  const red: OrderView = { ...sub, kind: "redemption" };
  it("starts a first leg once", () => {
    expect(firstLegMayStart(red, [])).toBe(true);
    expect(firstLegMayStart(red, [mint({ action: "burn", status: "in_progress" })])).toBe(false);
    expect(firstLegMayStart(red, [mint({ action: "burn", status: "failed" })])).toBe(false);
    expect(firstLegMayStart({ ...sub, kind: "distribution", shareAmount: null }, [])).toBe(true);
  });
  it("stops an order whose leg ended without completing", () => {
    expect(legNeedsAttention(sub, [pay(), mint({ status: "failed" })])).toBe(true);
    expect(legNeedsAttention(sub, [pay(), mint({ status: "policy_rejected" })])).toBe(true);
    expect(legNeedsAttention(sub, [pay(), mint({ status: "failed" }), mint()])).toBe(false);
    expect(legNeedsAttention(sub, [pay(), mint({ status: "in_progress" })])).toBe(false);
  });
});
