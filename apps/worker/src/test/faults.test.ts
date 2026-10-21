/** The fault-injection harness refuses to exist outside tests and local drills, and is unreachable from the worker. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChainObservationPort, CompressedAssetPort } from "@metafarm/domain";
import { assertFaultInjectionAllowed, firstTransactions, withExpiredObservations, withWrongProofs } from "./faults";

const observer: ChainObservationPort = { submit: async () => undefined, observe: async () => ({ status: "final" }) };
const assets: CompressedAssetPort = {
  getAsset: async () => null,
  getAssetProof: async () => ({ root: "r", proof: ["a", "b", "c"], leaf: "LeafHash111", nodeIndex: 8, tree: "Tree" }),
};

describe("fault-injection harness", () => {
  it("is refused in deployed environments and outside tests or a local drill", () => {
    for (const env of [{ VITEST: "true", APP_ENV: "staging" }, { VITEST: "true", APP_ENV: "production" }, { VITEST: "true", NODE_ENV: "production" }, { VITEST: "true", RAILWAY_ENVIRONMENT_NAME: "production" }, { VITEST: "true", RAILWAY_PROJECT_ID: "x" }, {}, { METAFARM_FAULT_DRILL: "yes" }]) {
      expect(() => assertFaultInjectionAllowed(env)).toThrow();
      expect(() => withExpiredObservations(observer, () => true, env)).toThrow();
      expect(() => withWrongProofs(assets, () => true, undefined, env)).toThrow();
    }
    expect(() => assertFaultInjectionAllowed({ VITEST: "true" })).not.toThrow();
    expect(() => assertFaultInjectionAllowed({ METAFARM_FAULT_DRILL: "local", APP_ENV: "development" })).not.toThrow();
  });

  it("misreports only the chosen transactions as expired, and passes sends through", async () => {
    let sent = 0;
    const o = withExpiredObservations({ ...observer, submit: async () => void sent++ }, firstTransactions(1, (t) => t.startsWith("mint-")), { VITEST: "true" });
    await o.submit({ txRef: "mint-1" } as never);
    expect(sent).toBe(1);
    expect(await o.observe({ network: "solana-devnet", txRef: "tree-1" })).toMatchObject({ status: "final" });
    expect(await o.observe({ network: "solana-devnet", txRef: "mint-1" })).toMatchObject({ status: "expired" });
    expect(await o.observe({ network: "solana-devnet", txRef: "mint-2" })).toMatchObject({ status: "final" });
    expect(await o.observe({ network: "solana-devnet", txRef: "mint-1" })).toMatchObject({ status: "expired" });
    expect([...o.misreported]).toEqual(["mint-1"]);
  });

  it("replaces the leaf hash of the chosen assets' proofs only", async () => {
    const a = withWrongProofs(assets, (id) => id === "bad", undefined, { VITEST: "true" });
    expect((await a.getAssetProof("solana-devnet", "good")).leaf).toBe("LeafHash111");
    const wrong = await a.getAssetProof("solana-devnet", "bad");
    expect(wrong.leaf).not.toBe("LeafHash111");
    expect(wrong.leaf).toHaveLength("LeafHash111".length);
    expect([...a.corrupted]).toEqual(["bad"]);
  });

  it("is never imported by the worker's runtime code", () => {
    for (const f of ["../main.ts", "../rwa/start.ts", "../rwa/engine.ts", "../rwa/preflight.ts"]) {
      let src = "";
      try {
        src = readFileSync(new URL(f, import.meta.url), "utf8");
      } catch {
        continue; // a file that does not exist on this branch imports nothing
      }
      expect(src).not.toMatch(/from ["'][^"']*test\/(faults|fake-solana)["']/);
    }
  });
});
