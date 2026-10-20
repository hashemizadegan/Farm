import { describe, expect, it } from "vitest";
import type { ClusterCheck } from "@metafarm/chain";
import { solanaClusterCheck } from "./solana-cluster";

describe("API Solana cluster check", () => {
  it("asks for the configured network, remembers a success and retries after a failure", async () => {
    const seen: ClusterCheck[] = [];
    let fail = true;
    const check = solanaClusterCheck({ url: "https://rpc.invalid/key", network: "solana-devnet" }, async (c) => {
      seen.push(c);
      if (fail) throw new Error("unavailable");
    });
    await expect(check()).rejects.toThrow("unavailable");
    fail = false;
    await check();
    await check();
    expect(seen).toHaveLength(2); // the failure is not remembered; the success is
    expect(seen[0]).toMatchObject({ url: "https://rpc.invalid/key", network: "solana-devnet", label: "RPC", attempts: 2 });
  });
});
