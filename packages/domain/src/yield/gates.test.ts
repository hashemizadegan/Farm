import { describe, expect, it } from "vitest";
import { YIELD_GATED_STEPS, YIELD_REQUIREMENTS, YieldGateError, unmetYieldGateRequirements, yieldGateRequirements, type YieldRequirement } from "./gates";

const real = { simulation: false, compressedNft: false, equipment: false, publicSummary: false };

describe("yield gates", () => {
  it("lists the plan's requirements for each step of a real cycle", () => {
    expect(yieldGateRequirements("register_evidence", real)).toEqual(["evidence_storage"]);
    expect(yieldGateRequirements("lock", real)).toEqual(["entitlement_instrument", "calculation_policy", "settlement_unit", "asset_class"]);
    expect(yieldGateRequirements("calculate", real)).toEqual(["holding_model", "verified_ownership_source", "payout_wallets"]);
    expect(yieldGateRequirements("approve", real)).toEqual(["attestation_quorum"]);
    expect(yieldGateRequirements("publish", real)).toEqual(["dispute_authority"]);
  });

  it("adds class-specific and public-summary requirements only when they apply", () => {
    expect(yieldGateRequirements("lock", { ...real, compressedNft: true })).toContain("compressed_nft_scope");
    expect(yieldGateRequirements("lock", { ...real, equipment: true })).toContain("equipment_linkage");
    expect(yieldGateRequirements("publish", { ...real, publicSummary: true })).toEqual(["dispute_authority", "public_exposure"]);
  });

  it("has no requirements for simulation cycles (they use simulation records)", () => {
    for (const step of YIELD_GATED_STEPS) expect(yieldGateRequirements(step, { ...real, simulation: true, compressedNft: true, equipment: true, publicSummary: true })).toEqual([]);
  });

  it("reports what is unmet, and fails closed when nothing is satisfied", () => {
    const none = new Set<YieldRequirement>();
    expect(unmetYieldGateRequirements("approve", real, none)).toEqual(["attestation_quorum"]);
    expect(unmetYieldGateRequirements("approve", real, new Set(["attestation_quorum"]))).toEqual([]);
    // The payout-wallet requirement is reported, never assumed satisfied (its consequence is an open question).
    expect(unmetYieldGateRequirements("calculate", real, new Set(["holding_model", "verified_ownership_source"]))).toEqual(["payout_wallets"]);
  });

  it("names a plan decision for every requirement", () => {
    for (const [k, d] of Object.entries(YIELD_REQUIREMENTS)) expect(d, k).toMatch(/^D-\d+/);
  });

  it("refuses an incomplete context or an unknown step", () => {
    expect(() => yieldGateRequirements("lock", { simulation: false } as never)).toThrow(YieldGateError);
    expect(() => yieldGateRequirements("fund" as never, real)).toThrow(YieldGateError);
  });
});
