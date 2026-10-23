/**
 * Display helpers for the marketplace pages (simulation only). Pure, so they are unit tested.
 *
 * The pages are behind NEXT_PUBLIC_MARKETPLACE_ENABLED (off by default; the build refuses it in production until the
 * owner approves a rollout). Amounts travel as integers in the currency's minor unit; inputs are in major units.
 */
import { CURRENCY_MINOR_DIGITS, type MarketCurrency, type MarketOrderStatus } from "@metafarm/domain";

export const marketplaceEnabled = (env: Record<string, string | undefined> = { NEXT_PUBLIC_MARKETPLACE_ENABLED: process.env.NEXT_PUBLIC_MARKETPLACE_ENABLED }) =>
  env.NEXT_PUBLIC_MARKETPLACE_ENABLED === "true";

/** Refuses the flag in a production build (used by next.config.ts). */
export function marketplaceBuildProblem(env: Record<string, string | undefined>): string | null {
  if (env.NEXT_PUBLIC_MARKETPLACE_ENABLED !== "true") return null;
  if (env.APP_ENV === "production") return "NEXT_PUBLIC_MARKETPLACE_ENABLED is refused in production: the marketplace is simulation-only and needs the owner's approval before a production rollout";
  return null;
}

/** "1,250,000 IRR" style, in the reader's locale (Persian digits and the rial name in Persian). */
export function formatMoney(localeTag: string, minor: number, currency: MarketCurrency): string {
  const digits = CURRENCY_MINOR_DIGITS[currency];
  return new Intl.NumberFormat(localeTag, { style: "currency", currency, currencyDisplay: localeTag.startsWith("fa") ? "name" : "code", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / 10 ** digits);
}

/**
 * A price typed in major units ("4500000", "12.5", Persian or Arabic-Indic digits, thousands separators) to minor
 * units; null when it is not a positive amount with at most the currency's decimals.
 */
export function parseMoney(input: string, currency: MarketCurrency): number | null {
  const s = toLatinDigits(input).replace(/[,\s٬_]/g, "").replace("٫", ".");
  if (!/^\d{1,15}(\.\d+)?$/.test(s)) return null;
  const digits = CURRENCY_MINOR_DIGITS[currency];
  const [, frac = ""] = s.split(".");
  if (frac.length > digits) return null;
  const minor = Math.round(Number(s) * 10 ** digits);
  return minor > 0 ? minor : null;
}

/** A quantity typed by a person (at most three decimals); null when invalid or not positive. */
export function parseQuantity(input: string): number | null {
  const s = toLatinDigits(input).replace(/[\s٬]/g, "").replace("٫", ".");
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

export function toLatinDigits(s: string): string {
  return s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

type Tone = "ok" | "pending" | "problem" | "neutral";

export function orderTone(status: MarketOrderStatus): Tone {
  if (status === "delivered" || status === "transferred") return "ok";
  if (status === "declined" || status === "cancelled" || status === "refunded") return "neutral";
  return "pending";
}

export function listingTone(status: string): Tone {
  if (status === "active") return "ok";
  if (status === "reserved") return "pending";
  return "neutral";
}

/** Order actions that undo something: asked to confirm first. */
export const CONFIRM_ACTIONS = new Set(["decline", "withdraw_offer", "cancel", "refund", "transfer"]);

/** Order of the steps a produce or registered-asset order goes through (for the progress line). */
export const ORDER_STEPS: Record<"produce" | "registered_asset", MarketOrderStatus[]> = {
  produce: ["awaiting_payment", "paid", "preparing", "dispatched", "delivered"],
  registered_asset: ["offer_pending", "awaiting_payment", "paid", "transferred"],
};

/** Index of the current step, or -1 when the order ended without completing. */
export function stepIndex(kind: "produce" | "registered_asset", status: MarketOrderStatus): number {
  return ORDER_STEPS[kind].indexOf(status);
}
