import { describe, expect, it } from "vitest";
import { holdersOf, rebuildOwnership, type ChainAssetRef, type OwnershipEvent } from "./ownership";

// Made-up base58 strings; not real accounts.
const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const leaf: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_BUBBLEGUM_CNFT", id: "LeafAsset1111111111111111111111111111111111" };
const share: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: "ShareMint1111111111111111111111111111111111" };

let n = 0;
const ev = (p: Partial<OwnershipEvent> & Pick<OwnershipEvent, "asset" | "kind" | "slot">): OwnershipEvent => ({
  from: null,
  to: null,
  amount: 1n,
  txIndex: 0,
  ixIndex: 0,
  signature: `sig${++n}`,
  ...p,
});

const history = (): OwnershipEvent[] => [
  ev({ asset: leaf, kind: "mint", to: A, slot: 100n, signature: "s1" }),
  ev({ asset: share, kind: "mint", to: A, amount: 1_000n, slot: 101n, signature: "s2" }),
  ev({ asset: leaf, kind: "transfer", from: A, to: B, slot: 110n, signature: "s3" }),
  ev({ asset: share, kind: "transfer", from: A, to: C, amount: 250n, slot: 120n, signature: "s4" }),
  ev({ asset: share, kind: "burn", from: C, amount: 50n, slot: 130n, signature: "s5" }),
];

describe("ownership projection", () => {
  it("follows mints, transfers and burns", () => {
    const p = rebuildOwnership(history());
    expect(p.applied).toBe(5);
    expect(p.conflicts).toEqual([]);
    expect(holdersOf(p, leaf).map((h) => [h.owner, h.amount])).toEqual([[B, 1n]]);
    expect(holdersOf(p, share).map((h) => [h.owner, h.amount])).toEqual([
      [A, 750n],
      [C, 200n],
    ]);
    expect(holdersOf(p, leaf)[0]).toMatchObject({ asOfSlot: 110n, lastSignature: "s3" });
    expect(p.lastSlot).toBe(130n);
  });

  it("rebuilds the same holdings whatever order the events arrive in", () => {
    const forward = rebuildOwnership(history());
    expect(rebuildOwnership([...history()].reverse())).toEqual(forward);
    const shuffled = history();
    [shuffled[0], shuffled[3]] = [shuffled[3]!, shuffled[0]!];
    expect(rebuildOwnership(shuffled)).toEqual(forward);
  });

  it("ignores identical replays and flags conflicting ones", () => {
    const h = history();
    const replayed = rebuildOwnership([...h, ...h, h[2]!]);
    expect(replayed.holdings).toEqual(rebuildOwnership(h).holdings);
    expect(replayed.duplicates).toBe(6);
    const forged = { ...h[2]!, to: C };
    const p = rebuildOwnership([...h, forged]);
    expect(p.conflicts).toEqual([{ event: forged, reason: "conflicting_duplicate" }]);
    expect(holdersOf(p, leaf).map((x) => x.owner)).toEqual([B]);
  });

  it("refuses transfers the sender could not make, without applying them", () => {
    const bad = ev({ asset: share, kind: "transfer", from: B, to: C, amount: 1n, slot: 140n });
    const p = rebuildOwnership([...history(), bad]);
    expect(p.conflicts).toEqual([{ event: bad, reason: "insufficient_balance" }]);
    expect(holdersOf(p, share).find((h) => h.owner === C)?.amount).toBe(200n);
  });

  it("allows a compressed NFT to be minted once, and only whole", () => {
    const again = ev({ asset: leaf, kind: "mint", to: C, slot: 150n });
    const half = ev({ asset: leaf, kind: "transfer", from: B, to: C, amount: 2n, slot: 151n });
    const p = rebuildOwnership([...history(), again, half]);
    expect(p.conflicts.map((c) => c.reason)).toEqual(["unique_asset_already_minted", "invalid_event"]);
    expect(holdersOf(p, leaf).map((x) => x.owner)).toEqual([B]);
  });

  it("rejects malformed events", () => {
    const events = [
      ev({ asset: share, kind: "mint", from: A, to: B, slot: 1n }),
      ev({ asset: share, kind: "burn", from: A, to: B, slot: 1n }),
      ev({ asset: share, kind: "transfer", from: A, to: null, slot: 1n }),
      ev({ asset: share, kind: "mint", to: A, amount: 0n, slot: 1n }),
    ];
    const p = rebuildOwnership(events);
    expect(p.applied).toBe(0);
    expect(p.conflicts.every((c) => c.reason === "invalid_event")).toBe(true);
    expect(p.holdings).toEqual([]);
  });

  it("keeps the same event on two networks apart", () => {
    const main = { ...leaf, network: "solana-mainnet" as const };
    const p = rebuildOwnership([ev({ asset: leaf, kind: "mint", to: A, slot: 1n, signature: "x" }), ev({ asset: main, kind: "mint", to: B, slot: 1n, signature: "x" })]);
    expect(p.applied).toBe(2);
    expect(p.duplicates).toBe(0);
  });

  it("is empty for no events", () => {
    expect(rebuildOwnership([])).toEqual({ holdings: [], applied: 0, duplicates: 0, conflicts: [], lastSlot: null });
  });
});
