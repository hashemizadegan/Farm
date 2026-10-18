/**
 * The compliance gate: whether a party (investor) and the wallets an order touches may transact.
 * Decisions come from recorded KYC and from sanctions screenings by a real provider; there are no
 * built-in lists. Anything unknown, stale or unclear blocks.
 */
import type { Network } from "./model";
import type { ScreeningOutcome } from "./ports";

export const PARTY_KINDS = ["person", "organisation"] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export const KYC_STATUSES = ["unverified", "pending", "verified", "rejected"] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const SCREENING_SUBJECTS = ["party", "wallet"] as const;
export const SCREENING_OUTCOMES = ["clear", "review", "blocked"] as const satisfies readonly ScreeningOutcome[];

export interface Screening {
  outcome: ScreeningOutcome;
  checkedAt: Date;
}

export interface PartyCompliance {
  kycStatus: KycStatus;
  /** When the KYC verification must be renewed. */
  kycExpiresAt: Date | null;
  /** ISO 3166-1 alpha-2 country of residence or incorporation. */
  jurisdiction: string | null;
  /** Latest sanctions screening of the party. */
  screening: Screening | null;
}

export interface WalletCompliance {
  network: Network;
  address: string;
  screening: Screening | null;
}

export interface CompliancePolicy {
  /** Screenings older than this are stale. */
  screeningMaxAgeDays: number;
  /** Jurisdictions the operator's counsel has excluded (ISO alpha-2). Set by the operator; empty by default. */
  blockedJurisdictions: readonly string[];
}

export const COMPLIANCE_REASONS = [
  "kyc_not_verified",
  "kyc_expired",
  "jurisdiction_unknown",
  "jurisdiction_blocked",
  "party_unscreened",
  "party_screening_stale",
  "party_needs_review",
  "party_blocked",
  "wallet_unscreened",
  "wallet_screening_stale",
  "wallet_needs_review",
  "wallet_blocked",
] as const;
export type ComplianceReason = (typeof COMPLIANCE_REASONS)[number];

const DAY = 86_400_000;

function screeningReasons(s: Screening | null, who: "party" | "wallet", policy: CompliancePolicy, now: Date): ComplianceReason[] {
  if (!s) return [`${who}_unscreened` as ComplianceReason];
  if (s.outcome === "blocked") return [`${who}_blocked` as ComplianceReason];
  const out: ComplianceReason[] = [];
  if (s.outcome === "review") out.push(`${who}_needs_review` as ComplianceReason);
  if (now.getTime() - s.checkedAt.getTime() > policy.screeningMaxAgeDays * DAY) out.push(`${who}_screening_stale` as ComplianceReason);
  return out;
}

/** Allowed only with verified, current KYC, a known and permitted jurisdiction, and clear, recent screenings of the party and every wallet. */
export function complianceDecision(party: PartyCompliance, wallets: WalletCompliance[], policy: CompliancePolicy, now: Date): { allowed: boolean; reasons: ComplianceReason[] } {
  const reasons: ComplianceReason[] = [];
  if (party.kycStatus !== "verified") reasons.push("kyc_not_verified");
  else if (party.kycExpiresAt && party.kycExpiresAt.getTime() <= now.getTime()) reasons.push("kyc_expired");
  if (!party.jurisdiction) reasons.push("jurisdiction_unknown");
  else if (policy.blockedJurisdictions.map((j) => j.toUpperCase()).includes(party.jurisdiction.toUpperCase())) reasons.push("jurisdiction_blocked");
  reasons.push(...screeningReasons(party.screening, "party", policy, now));
  for (const w of wallets) reasons.push(...screeningReasons(w.screening, "wallet", policy, now));
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
}
