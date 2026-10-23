/**
 * Marketplace (simulation only): eligible items are listed by the workspace that controls them, bought or offered on
 * by another workspace, and settled or delivered through an explicit state machine. Nothing here moves money, signs a
 * transaction or books a carrier: payment, refund, transfer of control and dispatch are recorded on the platform and
 * labelled as simulated or manual everywhere they are shown.
 *
 * Two kinds of item, with distinct eligibility rules:
 * - registered assets (business_assets): verified or active, of a listable kind, controlled by the seller (the
 *   platform's control ledger), with no mainnet representation, and not already on an open listing. A sale ends in a
 *   recorded transfer of control to the buyer's workspace (no token or title moves);
 * - physical produce (harvest batches): not voided, with quantity not already committed to other listings. A sale
 *   ends in a delivery the buyer confirms; the seller enters the dispatch and tracking reference by hand.
 */
import { z } from "zod";

export const MARKET_ITEM_KINDS = ["registered_asset", "produce"] as const;
export type MarketItemKind = (typeof MARKET_ITEM_KINDS)[number];

/** Currencies a price may be shown in. Amounts are integers in the currency's minor unit (rial: none; dollar: cents). */
export const MARKET_CURRENCIES = ["IRR", "USD"] as const;
export type MarketCurrency = (typeof MARKET_CURRENCIES)[number];
export const CURRENCY_MINOR_DIGITS: Record<MarketCurrency, number> = { IRR: 0, USD: 2 };

/** Registered asset kinds that may be listed. Harvest lots are sold as produce, from their harvest batch. */
export const LISTABLE_ASSET_KINDS = ["parcel", "tree", "livestock", "equipment", "farm_share"] as const;

export const SHIPPING_METHODS = ["pickup", "local_delivery", "courier_manual"] as const;
export type ShippingMethod = (typeof SHIPPING_METHODS)[number];

export const LISTING_STATUSES = ["active", "reserved", "sold_out", "sold", "withdrawn"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];
/** Listings anyone signed in can see in the catalogue. */
export const PUBLIC_LISTING_STATUSES: readonly ListingStatus[] = ["active", "reserved", "sold_out", "sold"];

export const PRICING_MODES = ["fixed", "offers"] as const;
export type PricingMode = (typeof PRICING_MODES)[number];

export const MARKET_ORDER_STATUSES = [
  "offer_pending",
  "awaiting_payment",
  "paid",
  "preparing",
  "dispatched",
  "delivered",
  "transferred",
  "declined",
  "cancelled",
  "refunded",
] as const;
export type MarketOrderStatus = (typeof MARKET_ORDER_STATUSES)[number];
/** No further action is possible. */
export const FINAL_MARKET_ORDER_STATUSES: readonly MarketOrderStatus[] = ["delivered", "transferred", "declined", "cancelled", "refunded"];

export const MARKET_ORDER_ACTIONS = ["accept", "decline", "withdraw_offer", "pay", "transfer", "prepare", "dispatch", "confirm_receipt", "cancel", "refund"] as const;
export type MarketOrderAction = (typeof MARKET_ORDER_ACTIONS)[number];
export type MarketOrderSide = "buyer" | "seller";

interface Transition {
  side: MarketOrderSide;
  kinds: readonly MarketItemKind[];
  from: readonly MarketOrderStatus[];
  to: MarketOrderStatus;
}

/** Every allowed transition. Anything else is refused. */
export const MARKET_ORDER_TRANSITIONS: Record<MarketOrderAction, Transition> = {
  accept: { side: "seller", kinds: ["registered_asset"], from: ["offer_pending"], to: "awaiting_payment" },
  decline: { side: "seller", kinds: ["registered_asset"], from: ["offer_pending"], to: "declined" },
  withdraw_offer: { side: "buyer", kinds: ["registered_asset"], from: ["offer_pending"], to: "cancelled" },
  pay: { side: "buyer", kinds: ["registered_asset", "produce"], from: ["awaiting_payment"], to: "paid" },
  transfer: { side: "seller", kinds: ["registered_asset"], from: ["paid"], to: "transferred" },
  prepare: { side: "seller", kinds: ["produce"], from: ["paid"], to: "preparing" },
  dispatch: { side: "seller", kinds: ["produce"], from: ["preparing"], to: "dispatched" },
  confirm_receipt: { side: "buyer", kinds: ["produce"], from: ["dispatched"], to: "delivered" },
  // Either party may call off an order nobody has paid for (simulated).
  cancel: { side: "buyer", kinds: ["registered_asset", "produce"], from: ["awaiting_payment"], to: "cancelled" },
  refund: { side: "seller", kinds: ["registered_asset", "produce"], from: ["paid", "preparing"], to: "refunded" },
};

/** The seller may also cancel an unpaid order. */
const SELLER_MAY_CANCEL = true;

export type TransitionResult = { ok: true; to: MarketOrderStatus } | { ok: false; reason: "not_your_action" | "not_for_this_item" | "not_in_this_state" };

/** Whether `side` may take `action` on an order of `kind` in `status`, and the status it leads to. */
export function nextOrderStatus(kind: MarketItemKind, status: MarketOrderStatus, action: MarketOrderAction, side: MarketOrderSide): TransitionResult {
  const t = MARKET_ORDER_TRANSITIONS[action];
  if (!t.kinds.includes(kind)) return { ok: false, reason: "not_for_this_item" };
  const sideOk = t.side === side || (action === "cancel" && side === "seller" && SELLER_MAY_CANCEL);
  if (!sideOk) return { ok: false, reason: "not_your_action" };
  if (!t.from.includes(status)) return { ok: false, reason: "not_in_this_state" };
  return { ok: true, to: t.to };
}

/** The actions `side` can take now (for the order page). */
export function availableOrderActions(kind: MarketItemKind, status: MarketOrderStatus, side: MarketOrderSide): MarketOrderAction[] {
  return MARKET_ORDER_ACTIONS.filter((a) => nextOrderStatus(kind, status, a, side).ok);
}

/** Orders that hold quantity or the item: they release it when they end without completing. */
export const RELEASING_STATUSES: readonly MarketOrderStatus[] = ["declined", "cancelled", "refunded"];
/** Orders still open (not final). */
export const isOpenOrder = (s: MarketOrderStatus) => !FINAL_MARKET_ORDER_STATUSES.includes(s);

// ── Eligibility ──────────────────────────────────────────────────────────

export const ASSET_INELIGIBILITY = ["not_verified", "suspended_or_retired", "kind_not_listable", "not_controlled_by_seller", "mainnet_representation", "already_listed"] as const;
export type AssetIneligibility = (typeof ASSET_INELIGIBILITY)[number];

export interface AssetEligibilityInput {
  kind: string;
  status: string;
  /** The listing workspace controls the asset (control ledger, or it registered the asset and it never changed hands). */
  controlledBySeller: boolean;
  /** Any representation on a mainnet network: listing would imply a real on-chain transfer. */
  hasMainnetRepresentation: boolean;
  /** An open listing (active or reserved) already exists for it. */
  openListing: boolean;
}

export function assetEligibility(a: AssetEligibilityInput): { eligible: boolean; reasons: AssetIneligibility[] } {
  const reasons: AssetIneligibility[] = [];
  if (a.status === "suspended" || a.status === "retired") reasons.push("suspended_or_retired");
  else if (a.status !== "verified" && a.status !== "active") reasons.push("not_verified");
  if (!(LISTABLE_ASSET_KINDS as readonly string[]).includes(a.kind)) reasons.push("kind_not_listable");
  if (!a.controlledBySeller) reasons.push("not_controlled_by_seller");
  if (a.hasMainnetRepresentation) reasons.push("mainnet_representation");
  if (a.openListing) reasons.push("already_listed");
  return { eligible: reasons.length === 0, reasons };
}

export const PRODUCE_INELIGIBILITY = ["voided", "nothing_available", "not_controlled_by_seller"] as const;
export type ProduceIneligibility = (typeof PRODUCE_INELIGIBILITY)[number];

export interface ProduceEligibilityInput {
  voided: boolean;
  controlledBySeller: boolean;
  batchQuantity: number;
  /** Quantity on other open listings, plus quantity already sold from closed ones. */
  committedQuantity: number;
}

export function produceEligibility(p: ProduceEligibilityInput): { eligible: boolean; reasons: ProduceIneligibility[]; available: number } {
  const reasons: ProduceIneligibility[] = [];
  const available = roundQty(Math.max(0, p.batchQuantity - p.committedQuantity));
  if (p.voided) reasons.push("voided");
  if (!p.controlledBySeller) reasons.push("not_controlled_by_seller");
  if (available <= 0) reasons.push("nothing_available");
  return { eligible: reasons.length === 0, reasons, available };
}

/** Quantities are kept to three decimals (as harvest batches are). */
export const roundQty = (q: number) => Math.round(q * 1000) / 1000;

// ── Money and delivery ───────────────────────────────────────────────────

export interface DeliveryOption {
  method: ShippingMethod;
  /** Flat fee in minor units. */
  feeMinor: number;
  /** Fee per unit of quantity in minor units. */
  perUnitMinor: number;
}

/** Line total (unit price × quantity), in minor units, rounded half up. */
export const lineTotal = (unitPriceMinor: number, quantity: number) => Math.round(unitPriceMinor * quantity);

/** Delivery cost estimate for a produce order; null when the listing does not offer that method. */
export function deliveryEstimate(options: readonly DeliveryOption[], method: ShippingMethod, quantity: number): number | null {
  const o = options.find((x) => x.method === method);
  if (!o) return null;
  return o.feeMinor + Math.round(o.perUnitMinor * quantity);
}

/** Methods that ship to the buyer, so they need an address. */
export const needsAddress = (m: ShippingMethod) => m !== "pickup";

// ── Requests ─────────────────────────────────────────────────────────────

const money = z.number().int().min(1).max(1e15);
const fee = z.number().int().min(0).max(1e15);
const qty = z
  .number()
  .positive()
  .max(1e9)
  .refine((n) => Math.abs(roundQty(n) - n) < 1e-9, "at most three decimals");

export const deliveryOptionSchema = z.object({ method: z.enum(SHIPPING_METHODS), feeMinor: fee, perUnitMinor: fee }).strict();

const listingBase = {
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  currency: z.enum(MARKET_CURRENCIES),
};

export const createListingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("registered_asset"),
      assetId: z.string().uuid(),
      pricing: z.enum(PRICING_MODES),
      /** The asking price; offers may be lower or higher. */
      priceMinor: money,
      ...listingBase,
    })
    .strict(),
  z
    .object({
      kind: z.literal("produce"),
      harvestBatchId: z.string().uuid(),
      quantity: qty,
      /** Price per unit of the batch's unit (e.g. per kg). */
      priceMinor: money,
      deliveryOptions: z
        .array(deliveryOptionSchema)
        .min(1)
        .max(3)
        .refine((a) => new Set(a.map((o) => o.method)).size === a.length, "each delivery method once"),
      ...listingBase,
    })
    .strict(),
]);
export type CreateListing = z.infer<typeof createListingSchema>;

export const deliveryAddressSchema = z
  .object({
    recipient: z.string().trim().min(1).max(120),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    region: z.string().trim().max(100).optional(),
    postalCode: z.string().trim().min(3).max(20),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/, "a two-letter country code")
      .transform((c) => c.toUpperCase()),
    phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,24}$/, "a phone number"),
  })
  .strict();
export type DeliveryAddress = z.infer<typeof deliveryAddressSchema>;

export const placeOrderSchema = z
  .object({
    listingId: z.string().uuid(),
    /** Produce only; a registered asset is always one. */
    quantity: qty.optional(),
    /** Registered assets listed for offers: the amount offered. */
    offerMinor: money.optional(),
    delivery: z.object({ method: z.enum(SHIPPING_METHODS), address: deliveryAddressSchema.optional() }).strict().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type PlaceOrder = z.infer<typeof placeOrderSchema>;

export const orderActionSchema = z
  .object({
    action: z.enum(MARKET_ORDER_ACTIONS),
    /** dispatch: the carrier or courier, as entered by the seller (no carrier is integrated). */
    carrier: z.string().trim().min(2).max(80).optional(),
    /** dispatch: the tracking or consignment reference given by that carrier. */
    trackingRef: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]{2,63}$/, "3–64 letters, digits, spaces, dots, dashes or slashes")
      .optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((a) => a.action !== "dispatch" || (a.carrier && a.trackingRef), { message: "dispatch needs the carrier and its tracking reference", path: ["trackingRef"] });
export type MarketOrderActionRequest = z.infer<typeof orderActionSchema>;

/** Stated on every marketplace page and in API responses. */
export const MARKET_SIMULATION_NOTICE =
  "SIMULATION ONLY: listings, offers, orders, payments, refunds, transfers of control and deliveries are recorded on this platform for demonstration. No money moves, no token or title is transferred, no carrier is booked.";
