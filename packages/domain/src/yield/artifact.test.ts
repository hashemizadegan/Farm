import { describe, expect, it } from "vitest";
import { YieldAmountError } from "./amounts";
import { buildCalculationArtifact, canonicalYieldArtifact, yieldArtifactHash } from "./artifact";
import { F3_ILLUSTRATION, inputs, simulationPolicy } from "./fixtures.test-support";
import { convertAmount } from "./fx";
import { calculateYieldWaterfall } from "./waterfall";

const rate = { num: 1n, den: 1n, source: "simulation-rate", observedAt: "2026-09-30T16:00:00Z" };

function exampleA() {
  const policy = simulationPolicy(F3_ILLUSTRATION);
  const ins = inputs({ gross: 1_240_000n, refunds: 40_000n, expenses: 700_000n });
  const result = calculateYieldWaterfall({ simulation: true }, policy, ins);
  return buildCalculationArtifact({
    cycle: { id: "00000000-0000-4000-8000-00000000000a", version: 1, simulation: true },
    policy,
    inputs: ins,
    result,
    settlement: { mint: "simulation-mint", network: "simulation", decimals: 6, rate, conversion: convertAmount(result.netDistributableYield, 2, 6, rate) },
  });
}

describe("calculation artifact", () => {
  it("serialises bigints as decimal strings with sorted keys", () => {
    expect(canonicalYieldArtifact({ b: 2n, a: [1n, "x"], c: { z: true, y: null } })).toBe('{"a":["1","x"],"b":"2","c":{"y":null,"z":true}}');
  });

  it("gives the same hash for the same inputs, whatever the key order", async () => {
    const h1 = await yieldArtifactHash(exampleA());
    const h2 = await yieldArtifactHash(exampleA());
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h2).toBe(h1);
    expect(await yieldArtifactHash({ b: 1n, a: 2n })).toBe(await yieldArtifactHash({ a: 2n, b: 1n }));
  });

  it("changes the hash when any input changes", async () => {
    const a = exampleA();
    const h = await yieldArtifactHash(a);
    expect(await yieldArtifactHash({ ...a, inputs: { ...a.inputs, refunds: 40_001n } })).not.toBe(h);
    expect(await yieldArtifactHash({ ...a, cycle: { ...a.cycle, version: 2 } })).not.toBe(h);
  });

  it("refuses floats, undefined array items and non-plain objects", () => {
    expect(() => canonicalYieldArtifact({ amount: 1.5 })).toThrow(YieldAmountError);
    expect(() => canonicalYieldArtifact({ list: [1n, undefined] })).toThrow(YieldAmountError);
    expect(() => canonicalYieldArtifact({ when: new Date(0) })).toThrow(YieldAmountError);
    expect(() => canonicalYieldArtifact({ big: 2 ** 60 })).toThrow(YieldAmountError);
  });

  it("records the scheme and the policy's entitlement reference", () => {
    const a = exampleA();
    expect(a.scheme).toBe("metafarm-yield-calculation/1");
    expect(a.policy.entitlement.id).toBe("simulation-entitlement");
    expect(a.settlement.conversion.value).toBe(3_825_000_000n);
  });
});
