import { describe, expect, it } from "vitest";
import { complianceDecision, type PartyCompliance, type WalletCompliance } from "./compliance";

const now = new Date("2026-10-18T09:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const policy = { screeningMaxAgeDays: 30, blockedJurisdictions: ["XX"] };
const party: PartyCompliance = { kycStatus: "verified", kycExpiresAt: new Date("2027-10-18T00:00:00Z"), jurisdiction: "AE", screening: { outcome: "clear", checkedAt: daysAgo(2) } };
const wallet: WalletCompliance = { network: "tron-nile", address: "T...", screening: { outcome: "clear", checkedAt: daysAgo(1) } };

describe("compliance gate", () => {
  it("allows a verified, screened party with screened wallets", () => {
    expect(complianceDecision(party, [wallet], policy, now)).toEqual({ allowed: true, reasons: [] });
  });

  it("blocks on KYC, jurisdiction and party screening problems", () => {
    const check = (p: Partial<PartyCompliance>) => complianceDecision({ ...party, ...p }, [wallet], policy, now).reasons;
    expect(check({ kycStatus: "pending" })).toEqual(["kyc_not_verified"]);
    expect(check({ kycExpiresAt: daysAgo(1) })).toEqual(["kyc_expired"]);
    expect(check({ jurisdiction: null })).toEqual(["jurisdiction_unknown"]);
    expect(check({ jurisdiction: "xx" })).toEqual(["jurisdiction_blocked"]);
    expect(check({ screening: null })).toEqual(["party_unscreened"]);
    expect(check({ screening: { outcome: "clear", checkedAt: daysAgo(31) } })).toEqual(["party_screening_stale"]);
    expect(check({ screening: { outcome: "review", checkedAt: daysAgo(1) } })).toEqual(["party_needs_review"]);
    expect(check({ screening: { outcome: "blocked", checkedAt: daysAgo(1) } })).toEqual(["party_blocked"]);
  });

  it("checks every wallet the order touches", () => {
    const r = complianceDecision(party, [wallet, { ...wallet, address: "other", screening: null }, { ...wallet, screening: { outcome: "blocked", checkedAt: daysAgo(1) } }], policy, now);
    expect(r).toEqual({ allowed: false, reasons: ["wallet_unscreened", "wallet_blocked"] });
  });

  it("has no built-in blocked jurisdictions", () => {
    expect(complianceDecision({ ...party, jurisdiction: "XX" }, [wallet], { screeningMaxAgeDays: 30, blockedJurisdictions: [] }, now).allowed).toBe(true);
  });
});
