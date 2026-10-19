import { describe, expect, it } from "vitest";
import { NETWORKS, RAILS, baseUnits, networkAllowed, railOf, representationValid, treeAcceptsMint } from "./model";

describe("RWA model", () => {
  it("keeps rails on their own networks", () => {
    expect(representationValid("SOLANA_TOKEN_2022", "solana-devnet")).toBe(true);
    expect(representationValid("SOLANA_BUBBLEGUM_CNFT", "tron-nile")).toBe(false);
    expect(representationValid("TRON_TRC20", "tron-nile")).toBe(true);
    expect(representationValid("TRON_TRC20", "solana-mainnet")).toBe(false);
    for (const r of RAILS) expect(NETWORKS.some((n) => representationValid(r, n))).toBe(true);
  });

  it("keeps mainnets closed until enabled", () => {
    expect(networkAllowed("solana-devnet", { mainnetEnabled: false })).toBe(true);
    expect(networkAllowed("tron-nile", { mainnetEnabled: false })).toBe(true);
    expect(networkAllowed("solana-mainnet", { mainnetEnabled: false })).toBe(false);
    expect(networkAllowed("tron-mainnet", { mainnetEnabled: false })).toBe(false);
    expect(networkAllowed("tron-mainnet", { mainnetEnabled: true })).toBe(true);
  });

  it("tells the rail from the network", () => {
    expect(railOf("solana-devnet")).toBe("solana");
    expect(railOf("tron-shasta")).toBe("tron");
  });

  it("takes whole base units only", () => {
    expect(baseUnits.safeParse("0").success).toBe(true);
    expect(baseUnits.safeParse("1000000").success).toBe(true);
    expect(baseUnits.safeParse("115792089237316195423570985008687907853269984665640564039457584007913129639935").success).toBe(true);
    for (const bad of ["-1", "1.5", "01", "", "1e6"]) expect(baseUnits.safeParse(bad).success).toBe(false);
  });

  it("mints into active trees with room only", () => {
    expect(treeAcceptsMint({ status: "active", mintedCount: 0n, capacity: 8n })).toBe(true);
    expect(treeAcceptsMint({ status: "active", mintedCount: 7n, capacity: 8n })).toBe(true);
    expect(treeAcceptsMint({ status: "active", mintedCount: 8n, capacity: 8n })).toBe(false);
    for (const status of ["planned", "creating", "full", "failed", "retired"] as const) {
      expect(treeAcceptsMint({ status, mintedCount: 0n, capacity: 8n })).toBe(false);
    }
  });
});
