import { describe, expect, it } from "vitest";
import type { ClusterCheck } from "@metafarm/chain";
import type { Network } from "@metafarm/domain";
import { solanaClusterCheck } from "./solana-cluster";

describe("API Solana cluster check", () => {
  it("remembers a success, never a failure", async () => {
    const seen: ClusterCheck[] = [];
    let fail = true;
    const check = solanaClusterCheck(() => ({ url: "https://rpc.invalid/key", network: "solana-devnet" }), async (c) => {
      seen.push(c);
      if (fail) throw new Error("unavailable");
    });
    await expect(check()).rejects.toThrow("unavailable");
    fail = false;
    await check();
    await check();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ url: "https://rpc.invalid/key", network: "solana-devnet", label: "RPC", attempts: 2 });
  });

  it("checks again whenever the URL or the network differs from the pair that passed", async () => {
    const seen: string[] = [];
    let cfg: { url: string; network: Network } = { url: "https://a.invalid/k1", network: "solana-devnet" };
    const check = solanaClusterCheck(() => cfg, async (c) => void seen.push(`${c.network} ${c.url}`));
    await check();
    await check(); // remembered
    cfg = { url: "https://b.invalid/k2", network: "solana-devnet" };
    await check(); // new URL: checked
    cfg = { url: "https://b.invalid/k2", network: "solana-mainnet" };
    await check(); // new network: checked
    await check(); // remembered again
    expect(seen).toEqual(["solana-devnet https://a.invalid/k1", "solana-devnet https://b.invalid/k2", "solana-mainnet https://b.invalid/k2"]);
  });

  it("forgets an earlier success once a different pair fails", async () => {
    let cfg: { url: string; network: Network } = { url: "https://a.invalid/k", network: "solana-devnet" };
    let calls = 0;
    const check = solanaClusterCheck(() => cfg, async (c) => {
      calls++;
      if (c.url.includes("b.invalid")) throw new Error("mismatch");
    });
    await check();
    cfg = { url: "https://b.invalid/k", network: "solana-devnet" };
    await expect(check()).rejects.toThrow("mismatch");
    cfg = { url: "https://a.invalid/k", network: "solana-devnet" };
    await check(); // checked again, not served from the earlier success
    expect(calls).toBe(3);
  });
});
