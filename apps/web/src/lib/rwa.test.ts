import { describe, expect, it } from "vitest";
import { allPages, assetTone, explorerUrl, isTestnet, leafTone, registrationTone, shortAddress } from "./rwa";

const ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

describe("RWA display helpers", () => {
  it("shortens long addresses and leaves short or missing ones alone", () => {
    expect(shortAddress(ADDR)).toBe("7xKX…gAsU");
    expect(shortAddress("abc")).toBe("abc");
    expect(shortAddress(null)).toBeNull();
    expect(shortAddress("")).toBeNull();
  });

  it("maps statuses to tones, with problems standing out", () => {
    expect(assetTone("verified")).toBe("ok");
    expect(assetTone("draft")).toBe("pending");
    expect(assetTone("suspended")).toBe("problem");
    expect(registrationTone("exception")).toBe("problem");
    expect(registrationTone("issuing")).toBe("pending");
    expect(registrationTone("completed")).toBe("ok");
    expect(leafTone("active")).toBe("ok");
    expect(leafTone("planned")).toBe("pending");
  });

  it("links only valid addresses, to the right cluster", () => {
    expect(explorerUrl("solana-devnet", ADDR)).toBe(`https://explorer.solana.com/address/${ADDR}?cluster=devnet`);
    expect(explorerUrl("solana-mainnet", ADDR)).toBe(`https://explorer.solana.com/address/${ADDR}`);
    expect(explorerUrl("tron-nile", ADDR)).toBeNull();
    expect(explorerUrl("solana-devnet", "not an address")).toBeNull();
    expect(explorerUrl("solana-devnet", null)).toBeNull();
  });

  it("labels testnets", () => {
    expect(isTestnet("solana-devnet")).toBe(true);
    expect(isTestnet("tron-nile")).toBe(true);
    expect(isTestnet("solana-mainnet")).toBe(false);
  });
});

describe("allPages", () => {
  const pages: Record<string, { items: number[]; nextCursor: string | null }> = {
    start: { items: [1, 2], nextCursor: "a" },
    a: { items: [3, 4], nextCursor: "b" },
    b: { items: [5], nextCursor: null },
  };
  const fetchPage = async (cursor: string | undefined) => pages[cursor ?? "start"]!;

  it("follows the cursor to the last page", async () => {
    expect(await allPages(fetchPage)).toEqual({ items: [1, 2, 3, 4, 5], truncated: false });
  });

  it("stops at the page limit and says the list is incomplete", async () => {
    expect(await allPages(fetchPage, 2)).toEqual({ items: [1, 2, 3, 4], truncated: true });
  });
});
