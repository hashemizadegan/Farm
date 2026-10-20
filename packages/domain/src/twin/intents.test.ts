import { describe, expect, it } from "vitest";
import type { ChainAssetRef } from "./ownership";
import type { OwnershipReading } from "./ports";
import { TransferRefused } from "./transfer";
import { buildMintIntent, buildTradeIntent, buildTransferIntent, intentToJson } from "./intents";

const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ISSUER = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const leaf: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_BUBBLEGUM_CNFT", id: "LeafAsset1111111111111111111111111111111111" };
const share: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: "ShareMint1111111111111111111111111111111111" };
const usd: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: "StabeMint1111111111111111111111111111111111" };
const ctx = { now: new Date("2026-10-20T19:00:00Z"), mainnetEnabled: false, submissionUnavailable: "not_enabled" as const };
const holds = (owner: string, amount: bigint, slot = 900n): OwnershipReading => ({ holders: [{ owner, amount }], asOfSlot: slot, assurance: "inclusion_verified" });
const none: OwnershipReading = { holders: [], asOfSlot: 800n, assurance: "inclusion_verified" };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TransferRefused) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("unsigned intents (data only)", () => {
  it("mints, transfers and trades as data with no signatures and no submission", async () => {
    const mint = await buildMintIntent({ asset: leaf, issuer: ISSUER, to: A, amount: 1n, holders: none }, ctx);
    const transfer = await buildTransferIntent({ leg: { asset: leaf, from: A, to: B, amount: 1n }, holders: holds(A, 1n) }, ctx);
    const trade = await buildTradeIntent({ asset: share, seller: A, buyer: B, amount: 10n, payment: usd, price: 2_500n, assetHolders: holds(A, 100n), paymentHolders: holds(B, 5_000n, 901n) }, ctx);
    for (const i of [mint, transfer, trade]) {
      expect(i.signatures).toEqual([]);
      expect(i.submission).toEqual({ available: false, reason: "not_enabled" });
      expect(i.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(i.expiresAt.getTime() - i.createdAt.getTime()).toBe(300_000);
    }
    expect(mint.requiredSigners).toEqual([ISSUER]);
    expect(transfer.requiredSigners).toEqual([A]);
    expect(trade.requiredSigners).toEqual([A, B]);
    expect(trade.legs.map((l) => [l.from, l.to, l.amount])).toEqual([
      [A, B, 10n],
      [B, A, 2_500n],
    ]);
    expect(trade.ownershipAsOfSlots).toEqual([900n, 901n]);
    expect(new Set([mint.digest, transfer.digest, trade.digest]).size).toBe(3);
    const json = intentToJson(trade);
    expect(json.legs[1]).toEqual({ asset: usd, from: B, to: A, amount: "2500" });
    expect(JSON.parse(JSON.stringify(json)).ownershipAsOfSlots).toEqual(["900", "901"]);
  });

  it("is deterministic for the same intent and time", async () => {
    const a = await buildTransferIntent({ leg: { asset: share, from: A, to: B, amount: 5n }, holders: holds(A, 5n) }, ctx);
    const b = await buildTransferIntent({ leg: { asset: share, from: A, to: B, amount: 5n }, holders: holds(A, 5n) }, ctx);
    expect(b.digest).toBe(a.digest);
  });

  it("refuses what the chain would not allow or the platform does not know", async () => {
    expect(await code(buildMintIntent({ asset: leaf, issuer: ISSUER, to: A, amount: 1n, holders: holds(B, 1n) }, ctx))).toBe("invalid_amount");
    expect(await code(buildMintIntent({ asset: leaf, issuer: ISSUER, to: A, amount: 1n, holders: null }, ctx))).toBe("ownership_not_indexed");
    expect(await code(buildMintIntent({ asset: leaf, issuer: "0xabc", to: A, amount: 1n, holders: none }, ctx))).toBe("invalid_address");
    expect(await code(buildTransferIntent({ leg: { asset: leaf, from: A, to: B, amount: 1n }, holders: null }, ctx))).toBe("ownership_not_indexed");
    expect(await code(buildTransferIntent({ leg: { asset: leaf, from: A, to: B, amount: 1n }, holders: holds(B, 1n) }, ctx))).toBe("sender_not_holder");
    const trade = { asset: share, seller: A, buyer: B, amount: 10n, payment: usd, price: 2_500n, assetHolders: holds(A, 100n), paymentHolders: holds(B, 5_000n) };
    expect(await code(buildTradeIntent({ ...trade, paymentHolders: holds(B, 10n) }, ctx))).toBe("sender_not_holder");
    expect(await code(buildTradeIntent({ ...trade, payment: leaf }, ctx))).toBe("rail_not_transferable");
    expect(await code(buildTradeIntent({ ...trade, payment: share }, ctx))).toBe("invalid_amount");
    expect(await code(buildTradeIntent({ ...trade, buyer: A }, ctx))).toBe("same_address");
    expect(await code(buildTradeIntent({ ...trade, payment: { ...usd, network: "solana-mainnet" } }, { ...ctx, mainnetEnabled: true }))).toBe("network_not_allowed");
    expect(await code(buildTransferIntent({ leg: { asset: { ...share, network: "solana-mainnet" }, from: A, to: B, amount: 1n }, holders: holds(A, 1n) }, ctx))).toBe("network_not_allowed");
  });
});
