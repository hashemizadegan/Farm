/**
 * The shared-cycle memo (large-holder.test-support.ts): one build per parameter set per process, keyed by every
 * parameter that changes the cycle — holders, seed, share profile and dust threshold. Small cycles keep this cheap.
 */
import { describe, expect, it } from "vitest";
import { type LargeCycleParams, SHARED_16K, largeCycleKey, largeHolderCycle, sharedLargeCycle, sharedLargeCycleKeys } from "./large-holder.test-support";

const base: LargeCycleParams = { holders: 24, seed: 0x5eedn, profile: "extreme", dustThreshold: 0n };

describe("shared cycle memo", () => {
  it("the key includes the seed and the dust threshold (and holders and profile)", () => {
    const k = largeCycleKey(base);
    expect(k).toBe("holders=24;seed=0x5eed;profile=extreme;dustThreshold=0");
    expect(largeCycleKey({ ...base, seed: 0x5eeen })).not.toBe(k);
    expect(largeCycleKey({ ...base, dustThreshold: 1n })).not.toBe(k);
    expect(largeCycleKey({ ...base, holders: 25 })).not.toBe(k);
    expect(largeCycleKey({ ...base, profile: "uniform" })).not.toBe(k);
    expect(largeCycleKey(SHARED_16K)).toBe("holders=16384;seed=0xe17e10e5;profile=extreme;dustThreshold=1000");
  });

  it("same parameters share one build; another seed or dust threshold builds a different cycle", async () => {
    const a = sharedLargeCycle(base);
    expect(sharedLargeCycle({ ...base })).toBe(a); // the same promise: built once
    const [ra, rb] = [await a, await sharedLargeCycle({ ...base })];
    expect(rb).toBe(ra);

    const otherSeed = await sharedLargeCycle({ ...base, seed: 0x5eeen });
    const otherDust = await sharedLargeCycle({ ...base, dustThreshold: 2_000_000_000n });
    expect(otherSeed).not.toBe(ra);
    expect(otherDust).not.toBe(ra);
    // Different inputs, different cycles: the seed changes the snapshot; the threshold changes the plan's policy.
    expect(otherSeed.ownership.snapshotHash).not.toBe(ra.ownership.snapshotHash);
    expect(otherDust.ownership.snapshotHash).toBe(ra.ownership.snapshotHash);
    expect(otherDust.artifactSha256).not.toBe(ra.artifactSha256);
    expect(otherDust.artifact.distribution.plan.policy.dustThreshold).toBe(2_000_000_000n);
    for (const p of [base, { ...base, seed: 0x5eeen }, { ...base, dustThreshold: 2_000_000_000n }]) expect(sharedLargeCycleKeys()).toContain(largeCycleKey(p));
  });

  it("is deterministic and deeply frozen, so tests sharing a cycle cannot change it", async () => {
    const r = await sharedLargeCycle(base);
    expect(Object.isFrozen(r) && Object.isFrozen(r.artifact) && Object.isFrozen(r.ownership) && Object.isFrozen(r.input) && Object.isFrozen(r.input.distributionPolicy)).toBe(true);
    expect(() => {
      (r.artifact.totals as { inflow: bigint }).inflow = 0n;
    }).toThrow(TypeError);
    // A fresh build with the same parameters (bypassing the memo) gives the same artifact hash.
    expect((await largeHolderCycle(base.holders, base.seed, undefined, base.dustThreshold, base.profile)).artifactSha256).toBe(r.artifactSha256);
  });

  it("stays fail-closed: refuses malformed or extra parameters instead of guessing", () => {
    for (const bad of [{ ...base, holders: 0 }, { ...base, seed: -1n }, { ...base, profile: "gaussian" }, { ...base, dustThreshold: -1n }, { ...base, dustThreshold: 5 }, { ...base, networkId: "solana-mainnet" }])
      expect(() => sharedLargeCycle(bad as never), JSON.stringify(Object.keys(bad))).toThrow();
  });
});
