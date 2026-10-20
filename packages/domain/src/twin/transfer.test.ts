import { describe, expect, it } from "vitest";
import type { ChainAssetRef } from "./ownership";
import type { OwnershipReading } from "./ports";
import { TRANSFER_PREVIEW_SCHEME, TransferRefused, previewTransfer, type TransferPreviewRequest } from "./transfer";

const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const leaf: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_BUBBLEGUM_CNFT", id: "LeafAsset1111111111111111111111111111111111" };
const share: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: "ShareMint1111111111111111111111111111111111" };
const now = new Date("2026-10-20T19:00:00Z");
const holds = (owner: string, amount: bigint): OwnershipReading => ({ holders: [{ owner, amount }], asOfSlot: 500n, assurance: "inclusion_verified" });
const opts = (holders: OwnershipReading | null, extra: Partial<{ mainnetEnabled: boolean }> = {}) => ({
  now,
  mainnetEnabled: false,
  holders,
  submissionUnavailable: "not_implemented" as const,
  ...extra,
});

async function refusal(req: TransferPreviewRequest, o: ReturnType<typeof opts>): Promise<string> {
  try {
    await previewTransfer(req, o);
  } catch (err) {
    if (err instanceof TransferRefused) return err.code;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("transfer preview (preparation without submission)", () => {
  it("describes the transfer, fingerprints it, and never offers submission", async () => {
    const p = await previewTransfer({ asset: leaf, from: A, to: B, amount: 1n }, opts(holds(A, 1n)));
    expect(p).toMatchObject({ scheme: TRANSFER_PREVIEW_SCHEME, from: A, to: B, amount: 1n, ownershipAsOfSlot: 500n });
    expect(p.submission).toEqual({ available: false, reason: "not_implemented" });
    expect(p.expiresAt.getTime() - p.createdAt.getTime()).toBe(120_000);
    expect(p.digest).toMatch(/^[0-9a-f]{64}$/);
    const again = await previewTransfer({ asset: leaf, from: A, to: B, amount: 1n }, opts(holds(A, 1n)));
    expect(again.digest).toBe(p.digest);
    const other = await previewTransfer({ asset: share, from: A, to: B, amount: 5n }, opts(holds(A, 10n)));
    expect(other.digest).not.toBe(p.digest);
  });

  it("refuses when the chain's holders are unknown or do not include the sender", async () => {
    expect(await refusal({ asset: leaf, from: A, to: B, amount: 1n }, opts(null))).toBe("ownership_not_indexed");
    expect(await refusal({ asset: leaf, from: A, to: B, amount: 1n }, opts(holds(B, 1n)))).toBe("sender_not_holder");
    expect(await refusal({ asset: share, from: A, to: B, amount: 11n }, opts(holds(A, 10n)))).toBe("sender_not_holder");
  });

  it("refuses mainnet unless enabled, other rails, bad addresses and amounts", async () => {
    const main = { ...leaf, network: "solana-mainnet" as const };
    expect(await refusal({ asset: main, from: A, to: B, amount: 1n }, opts(holds(A, 1n)))).toBe("network_not_allowed");
    const trc = { network: "tron-nile" as const, rail: "TRON_TRC20" as const, id: "TXYZ" };
    expect(await refusal({ asset: trc, from: A, to: B, amount: 1n }, opts(holds(A, 1n)))).toBe("rail_not_transferable");
    expect(await refusal({ asset: leaf, from: "0xabc", to: B, amount: 1n }, opts(holds(A, 1n)))).toBe("invalid_address");
    expect(await refusal({ asset: leaf, from: A, to: A, amount: 1n }, opts(holds(A, 1n)))).toBe("same_address");
    expect(await refusal({ asset: leaf, from: A, to: B, amount: 2n }, opts(holds(A, 2n)))).toBe("invalid_amount");
    expect(await refusal({ asset: share, from: A, to: B, amount: 0n }, opts(holds(A, 2n)))).toBe("invalid_amount");
    expect(await refusal({ asset: share, from: A, to: B, amount: 1n << 64n }, opts(holds(A, 1n << 65n)))).toBe("invalid_amount");
  });
});
