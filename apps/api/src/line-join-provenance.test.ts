/**
 * Line join: fixture and verified-RPC ownership never meet silently, on either side of the join. Each layer refuses
 * on its own: the source combiner (F2), the Y5 service rule (D-17), the yield-line snapshot (simulation networks
 * only) and the engine adapter. Offline.
 */
import { describe, expect, it } from "vitest";
import { OwnershipHistoryError, base58Encode, combineOwnershipSources, createFixtureEventSource, createToken2022OwnershipSource, type SolanaHistoryRpc } from "@metafarm/chain";
import { buildWeightedOwnershipInput, type ChainAssetRef } from "@metafarm/domain";
import { OwnershipSnapshotError, verifyAndNormalizeSnapshot } from "@metafarm/domain/yield";

const key = (b: number) => base58Encode(new Uint8Array(32).fill(b));
const asset: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: key(50) };
const noCalls: SolanaHistoryRpc = {
  getFinalizedSlot: async () => {
    throw new Error("no network in this test");
  },
  getSignaturesForAddress: async () => {
    throw new Error("no network in this test");
  },
  getTransaction: async () => {
    throw new Error("no network in this test");
  },
};

async function code(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).name;
  }
  return "no error";
}

describe("fixture and verified RPC ownership are never combined silently (line join)", () => {
  it("the source combiner refuses mixed kinds (Y0 review F2)", () => {
    const rpc = createToken2022OwnershipSource(noCalls, "solana-devnet");
    const fixture = createFixtureEventSource([], 0n);
    expect(() => combineOwnershipSources(rpc, fixture)).toThrow(OwnershipHistoryError);
    expect(() => combineOwnershipSources(fixture, rpc)).toThrow(OwnershipHistoryError);
    expect(combineOwnershipSources(fixture, createFixtureEventSource([], 0n)).name).toBe("fixture");
  });

  it("fixture history never builds a real cycle's ownership input (D-17, service layer)", async () => {
    const history = { asset, events: [{ asset, kind: "mint" as const, from: null, to: key(51), amount: 5n, slot: 1n, txIndex: 0, ixIndex: 0, signature: "s1" }], provenance: { sourceKind: "fixture" as const, sourceIdentity: null, cursorSlot: 10n } };
    const build = (simulation: boolean) => buildWeightedOwnershipInput({ history, window: { startSlot: 0n, endSlot: 5n }, partyOfWallet: new Map(), simulation });
    expect(await code(() => build(false))).toBe("fixture_in_real_cycle");
    expect((await build(true)).provenance.sourceKind).toBe("fixture");
  });

  it("the yield-line snapshot still refuses a real network name: devnet ownership cannot enter the simulation pipeline", async () => {
    const input = { snapshotId: "00000000-0000-4000-8000-000000000001", assetId: asset.id, networkId: "solana-devnet", reference: { kind: "slot" as const, value: 5n, observedAt: "2026-01-01T00:00:00Z" }, entries: [{ partyId: "p", payoutAddress: null, rawShares: 1n }], unattributed: [] };
    await expect(verifyAndNormalizeSnapshot(input, { verifiedAt: "2026-01-01T00:00:00Z" })).rejects.toBeInstanceOf(OwnershipSnapshotError);
    expect(await code(() => verifyAndNormalizeSnapshot(input, { verifiedAt: "2026-01-01T00:00:00Z" }))).toBe("real_network");
  });
});
