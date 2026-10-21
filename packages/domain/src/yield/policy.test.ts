import { describe, expect, it } from "vitest";
import { F3_ILLUSTRATION, simulationPolicy } from "./fixtures.test-support";
import { YieldPolicyError, assertYieldPolicy, yieldPolicyProblems } from "./policy";

describe("calculation policy validation", () => {
  it("accepts a complete policy", () => {
    expect(yieldPolicyProblems(simulationPolicy(F3_ILLUSTRATION))).toEqual([]);
  });

  it("has no defaults: an empty object reports every required field", () => {
    const problems = yieldPolicyProblems({});
    for (const field of ["id", "version", "status", "formulaVersion", "entitlement", "accountingCurrency", "conversionDateRule", "recognitionBasis", "lossCarryForward", "reserves", "fee", "allowEstimatedCosts"])
      expect(problems.some((p) => p.startsWith(field)), field).toBe(true);
    expect(() => assertYieldPolicy({})).toThrow(YieldPolicyError);
  });

  it("requires 'none' to be written as null, never left out", () => {
    const p = simulationPolicy(F3_ILLUSTRATION) as unknown as Record<string, unknown>;
    const fee = { alternative: "F3", basisPoints: 1000n };
    expect(yieldPolicyProblems({ ...p, fee })).toEqual(["fee.minimum must be given (null for none)", "fee.maximum must be given (null for none)"]);
    const reserves = { maintenanceBasisPoints: 1000n, riskBasisPoints: 500n };
    expect(yieldPolicyProblems({ ...p, reserves })).toEqual(["reserves.maintenanceCap must be given (null for none)", "reserves.riskCap must be given (null for none)"]);
  });

  it("requires the loss-cycle choice explicitly for F1 and F4, and a cap choice for F4", () => {
    const p = simulationPolicy(F3_ILLUSTRATION) as unknown as Record<string, unknown>;
    expect(yieldPolicyProblems({ ...p, fee: { alternative: "F1", basisPoints: 1n, minimum: null, maximum: null } })).toEqual(["fee.chargeInLossCycle must be true or false"]);
    expect(yieldPolicyProblems({ ...p, fee: { alternative: "F4", schedule: { kind: "fixed", amount: 1n }, chargeInLossCycle: false, minimum: null, maximum: null } })).toEqual([
      "fee.capBasisPointsOfNetRevenue must be given (null for none)",
    ]);
  });

  it("refuses unsupported keys at every level instead of ignoring them", () => {
    const p = simulationPolicy(F3_ILLUSTRATION) as unknown as Record<string, unknown>;
    expect(yieldPolicyProblems({ ...p, feeAlternative: "F1" })).toEqual(["policy has unsupported keys: feeAlternative"]);
    // F2 has no loss-cycle switch: supplying one must not look as if it took effect.
    expect(yieldPolicyProblems({ ...p, fee: { alternative: "F2", basisPoints: 1000n, chargeInLossCycle: true, minimum: null, maximum: null } })).toEqual(["fee has unsupported keys: chargeInLossCycle"]);
    expect(yieldPolicyProblems({ ...p, reserves: { maintenanceBasisPoints: 0n, maintenanceCap: null, riskBasisPoints: 0n, riskCap: null, climateBasisPoints: 1n } })).toEqual(["reserves has unsupported keys: climateBasisPoints"]);
    expect(yieldPolicyProblems({ ...p, lossCarryForward: { enabled: true, expiresAfterCycles: 3 } })).toEqual(["lossCarryForward has unsupported keys: expiresAfterCycles"]);
    expect(
      yieldPolicyProblems({ ...p, fee: { alternative: "F4", schedule: { kind: "fixed", amount: 1n, currency: "USD" }, capBasisPointsOfNetRevenue: null, chargeInLossCycle: false, minimum: null, maximum: null } }),
    ).toEqual(["fee.schedule has unsupported keys: currency"]);
  });

  it("refuses out-of-range and inconsistent values, and numbers where bigints are required", () => {
    const p = simulationPolicy(F3_ILLUSTRATION);
    expect(yieldPolicyProblems({ ...p, reserves: { ...p.reserves, maintenanceBasisPoints: 10_001n } })).toHaveLength(1);
    expect(yieldPolicyProblems({ ...p, reserves: { ...p.reserves, maintenanceBasisPoints: 6000n, riskBasisPoints: 5000n } })).toEqual(["reserve basis points must not add up to more than 10000"]);
    expect(yieldPolicyProblems({ ...p, fee: { ...F3_ILLUSTRATION, minimum: 10n, maximum: 5n } })).toEqual(["fee.minimum must not exceed fee.maximum"]);
    expect(yieldPolicyProblems({ ...p, fee: { ...F3_ILLUSTRATION, basisPoints: 1000 as never } })).toHaveLength(1);
    expect(yieldPolicyProblems({ ...p, entitlement: { ...p.entitlement, sha256: "XYZ" } })).toHaveLength(1);
    expect(yieldPolicyProblems({ ...p, accountingCurrency: { code: "usd", exponent: 2 } })).toHaveLength(1);
    expect(yieldPolicyProblems({ ...p, formulaVersion: "yield-formula/9" as never })).toHaveLength(1);
    expect(
      yieldPolicyProblems({ ...p, fee: { alternative: "F4", schedule: { kind: "tiered", tiers: [{ fromNetRevenue: 5n, amount: 1n }, { fromNetRevenue: 5n, amount: 2n }] }, capBasisPointsOfNetRevenue: null, chargeInLossCycle: false, minimum: null, maximum: null } }),
    ).toEqual(["fee.schedule.tiers must be in strictly increasing fromNetRevenue order"]);
  });
});
