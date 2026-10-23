import { describe, expect, it } from "vitest";
import {
  MARKET_ORDER_ACTIONS,
  MARKET_ORDER_STATUSES,
  assetEligibility,
  availableOrderActions,
  createListingSchema,
  deliveryEstimate,
  isOpenOrder,
  lineTotal,
  nextOrderStatus,
  orderActionSchema,
  placeOrderSchema,
  produceEligibility,
  type MarketItemKind,
  type MarketOrderStatus,
} from "./marketplace";

const asset = { kind: "livestock", status: "verified", controlledBySeller: true, hasMainnetRepresentation: false, openListing: false };

describe("marketplace eligibility", () => {
  it("lists a verified or active, controlled registered asset of a listable kind", () => {
    expect(assetEligibility(asset)).toEqual({ eligible: true, reasons: [] });
    expect(assetEligibility({ ...asset, status: "active", kind: "farm_share" }).eligible).toBe(true);
  });

  it("refuses unverified, suspended, unlistable, uncontrolled, mainnet and already listed assets, with every reason", () => {
    expect(assetEligibility({ ...asset, status: "draft" }).reasons).toEqual(["not_verified"]);
    expect(assetEligibility({ ...asset, status: "retired" }).reasons).toEqual(["suspended_or_retired"]);
    expect(assetEligibility({ ...asset, kind: "harvest_lot" }).reasons).toEqual(["kind_not_listable"]);
    expect(assetEligibility({ ...asset, controlledBySeller: false }).reasons).toEqual(["not_controlled_by_seller"]);
    expect(assetEligibility({ ...asset, hasMainnetRepresentation: true }).reasons).toEqual(["mainnet_representation"]);
    expect(assetEligibility({ ...asset, openListing: true }).reasons).toEqual(["already_listed"]);
    expect(assetEligibility({ kind: "harvest_lot", status: "draft", controlledBySeller: false, hasMainnetRepresentation: true, openListing: true }).reasons).toHaveLength(5);
  });

  it("lists produce only from a live batch, up to what is not already committed", () => {
    expect(produceEligibility({ voided: false, controlledBySeller: true, batchQuantity: 120, committedQuantity: 20.5 })).toEqual({ eligible: true, reasons: [], available: 99.5 });
    expect(produceEligibility({ voided: true, controlledBySeller: true, batchQuantity: 120, committedQuantity: 0 }).reasons).toEqual(["voided"]);
    expect(produceEligibility({ voided: false, controlledBySeller: true, batchQuantity: 10, committedQuantity: 10 }).reasons).toEqual(["nothing_available"]);
    expect(produceEligibility({ voided: false, controlledBySeller: false, batchQuantity: 10, committedQuantity: 0 }).reasons).toEqual(["not_controlled_by_seller"]);
  });
});

describe("marketplace order state machine", () => {
  const walk = (kind: MarketItemKind, start: MarketOrderStatus, steps: [Parameters<typeof nextOrderStatus>[2], "buyer" | "seller"][]) => {
    let s = start;
    for (const [action, side] of steps) {
      const r = nextOrderStatus(kind, s, action, side);
      if (!r.ok) throw new Error(`${action} by ${side} from ${s}: ${r.reason}`);
      s = r.to;
    }
    return s;
  };

  it("takes a registered asset from an offer to a recorded transfer of control", () => {
    expect(walk("registered_asset", "offer_pending", [["accept", "seller"], ["pay", "buyer"], ["transfer", "seller"]])).toBe("transferred");
  });

  it("takes produce from order to confirmed delivery", () => {
    expect(walk("produce", "awaiting_payment", [["pay", "buyer"], ["prepare", "seller"], ["dispatch", "seller"], ["confirm_receipt", "buyer"]])).toBe("delivered");
  });

  it("only the right party acts, only on the right kind, only from the right state", () => {
    expect(nextOrderStatus("produce", "awaiting_payment", "pay", "seller")).toEqual({ ok: false, reason: "not_your_action" });
    expect(nextOrderStatus("produce", "dispatched", "confirm_receipt", "seller")).toEqual({ ok: false, reason: "not_your_action" });
    expect(nextOrderStatus("registered_asset", "paid", "prepare", "seller")).toEqual({ ok: false, reason: "not_for_this_item" });
    expect(nextOrderStatus("produce", "paid", "transfer", "seller")).toEqual({ ok: false, reason: "not_for_this_item" });
    expect(nextOrderStatus("produce", "awaiting_payment", "dispatch", "seller")).toEqual({ ok: false, reason: "not_in_this_state" });
    // Unpaid: either party cancels. Paid: only a (simulated) refund by the seller, and never after dispatch.
    expect(nextOrderStatus("produce", "awaiting_payment", "cancel", "seller").ok).toBe(true);
    expect(nextOrderStatus("produce", "paid", "cancel", "buyer").ok).toBe(false);
    expect(nextOrderStatus("produce", "preparing", "refund", "seller")).toEqual({ ok: true, to: "refunded" });
    expect(nextOrderStatus("produce", "dispatched", "refund", "seller").ok).toBe(false);
  });

  it("final states allow nothing", () => {
    for (const s of MARKET_ORDER_STATUSES.filter((x) => !isOpenOrder(x))) {
      for (const side of ["buyer", "seller"] as const) {
        expect(availableOrderActions("produce", s, side), s).toEqual([]);
        expect(availableOrderActions("registered_asset", s, side), s).toEqual([]);
      }
    }
    expect(MARKET_ORDER_ACTIONS.length).toBe(10);
  });
});

describe("marketplace money, delivery and requests", () => {
  const options = [
    { method: "pickup" as const, feeMinor: 0, perUnitMinor: 0 },
    { method: "courier_manual" as const, feeMinor: 250_000, perUnitMinor: 20_000 },
  ];

  it("estimates delivery per method and quantity, and refuses a method the listing does not offer", () => {
    expect(deliveryEstimate(options, "pickup", 12)).toBe(0);
    expect(deliveryEstimate(options, "courier_manual", 2.5)).toBe(300_000);
    expect(deliveryEstimate(options, "local_delivery", 1)).toBeNull();
    expect(lineTotal(4_500_000, 2.5)).toBe(11_250_000);
  });

  it("validates listings, orders and actions", () => {
    expect(createListingSchema.safeParse({ kind: "produce", harvestBatchId: "00000000-0000-4000-8000-000000000001", quantity: 10.1234, priceMinor: 1, currency: "IRR", title: "x", deliveryOptions: options }).success).toBe(false);
    expect(createListingSchema.safeParse({ kind: "produce", harvestBatchId: "00000000-0000-4000-8000-000000000001", quantity: 10.5, priceMinor: 1, currency: "IRR", title: "x", deliveryOptions: [options[0], options[0]] }).success).toBe(false);
    expect(createListingSchema.safeParse({ kind: "registered_asset", assetId: "00000000-0000-4000-8000-000000000001", pricing: "offers", priceMinor: 100, currency: "USD", title: "Ewe" }).success).toBe(true);
    expect(placeOrderSchema.safeParse({ listingId: "00000000-0000-4000-8000-000000000001", quantity: 1, delivery: { method: "pickup" } }).success).toBe(true);
    expect(orderActionSchema.safeParse({ action: "dispatch" }).success).toBe(false);
    expect(orderActionSchema.safeParse({ action: "dispatch", carrier: "Manual courier", trackingRef: "MC-2026-0001" }).success).toBe(true);
  });
});
