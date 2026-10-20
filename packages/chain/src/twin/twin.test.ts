import { describe, expect, it } from "vitest";
import { SubmissionDisabledError, previewTransfer, type CompressedAssetPort } from "@metafarm/domain";
import { DasOwnershipReader, FIXTURE_ASSETS, FIXTURE_EVENTS, FIXTURE_WALLETS, createFixtureLedger, createTransactionSubmitter, submissionUnavailableReason } from "./index";

describe("fixture ledger", () => {
  it("reads holders rebuilt from chain events, marked as fixture data", async () => {
    const ledger = createFixtureLedger(FIXTURE_EVENTS);
    expect(await ledger.holdersOf(FIXTURE_ASSETS.parcelLeaf)).toEqual({
      holders: [{ owner: FIXTURE_WALLETS.buyer, amount: 1n }],
      asOfSlot: 310_001_500n,
      assurance: "fixture",
    });
    const shares = await ledger.holdersOf(FIXTURE_ASSETS.shareMint);
    expect(shares?.holders).toEqual(
      [
        { owner: FIXTURE_WALLETS.custodian, amount: 750_000n },
        { owner: FIXTURE_WALLETS.investor, amount: 250_000n },
      ].sort((a, b) => (a.owner < b.owner ? -1 : 1)),
    );
    expect(await ledger.holdersOf({ ...FIXTURE_ASSETS.parcelLeaf, id: FIXTURE_WALLETS.buyer })).toBeNull();
  });

  it("gives the same answer after events are replayed", async () => {
    const ledger = createFixtureLedger(FIXTURE_EVENTS);
    const before = await ledger.holdersOf(FIXTURE_ASSETS.shareMint);
    ledger.append(FIXTURE_EVENTS);
    expect(await ledger.holdersOf(FIXTURE_ASSETS.shareMint)).toEqual(before);
    expect(ledger.projection().duplicates).toBe(FIXTURE_EVENTS.length);
  });
});

describe("DAS ownership reader", () => {
  const record = { id: FIXTURE_ASSETS.parcelLeaf.id, owner: FIXTURE_WALLETS.buyer, tree: FIXTURE_WALLETS.custodian, leafIndex: 0, compressed: true, burnt: false, frozen: false };
  const port = (o: { asset?: typeof record | null; proof?: "ok" | "stale" }): CompressedAssetPort => ({
    getAsset: async () => (o.asset === undefined ? record : o.asset),
    getAssetProof: async () => {
      if (o.proof === "stale") throw new Error("stale");
      return { root: "r", proof: [], leaf: "l", nodeIndex: 1, tree: record.tree };
    },
  });

  it("reports the owner, verified only when the proof's root is accepted", async () => {
    expect(await new DasOwnershipReader(port({ proof: "ok" }), "solana-devnet").holdersOf(FIXTURE_ASSETS.parcelLeaf)).toEqual({
      holders: [{ owner: FIXTURE_WALLETS.buyer, amount: 1n }],
      asOfSlot: null,
      assurance: "inclusion_verified",
    });
    expect((await new DasOwnershipReader(port({ proof: "stale" }), "solana-devnet").holdersOf(FIXTURE_ASSETS.parcelLeaf))?.assurance).toBe("indexer_reported");
  });

  it("covers only compressed NFTs on its own network", async () => {
    const r = new DasOwnershipReader(port({}), "solana-devnet");
    expect(await r.holdersOf(FIXTURE_ASSETS.shareMint)).toBeNull();
    expect(await r.holdersOf({ ...FIXTURE_ASSETS.parcelLeaf, network: "solana-mainnet" })).toBeNull();
    expect(await new DasOwnershipReader(port({ asset: null }), "solana-devnet").holdersOf(FIXTURE_ASSETS.parcelLeaf)).toBeNull();
    expect(await new DasOwnershipReader(port({ asset: { ...record, compressed: false } }), "solana-devnet").holdersOf(FIXTURE_ASSETS.parcelLeaf)).toBeNull();
    expect((await new DasOwnershipReader(port({ asset: { ...record, burnt: true } }), "solana-devnet").holdersOf(FIXTURE_ASSETS.parcelLeaf))?.holders).toEqual([]);
  });
});

describe("transaction submitter", () => {
  it("fails closed for every configuration, naming the first missing piece", async () => {
    expect(submissionUnavailableReason({ signerConfigured: true, network: "solana-devnet", mainnetEnabled: false })).toBe("not_enabled");
    expect(submissionUnavailableReason({ enabled: true, signerConfigured: false, network: "solana-devnet", mainnetEnabled: false })).toBe("no_signer");
    expect(submissionUnavailableReason({ enabled: true, signerConfigured: true, network: "solana-mainnet", mainnetEnabled: false })).toBe("mainnet_blocked");
    expect(submissionUnavailableReason({ enabled: true, signerConfigured: true, network: "solana-devnet", mainnetEnabled: false })).toBe("not_implemented");
    for (const cfg of [
      { signerConfigured: false, network: "solana-devnet" as const, mainnetEnabled: false },
      { enabled: true, signerConfigured: true, network: "solana-mainnet" as const, mainnetEnabled: true },
    ]) {
      const s = createTransactionSubmitter(cfg);
      expect(s.available).toBe(false);
      await expect(s.submit("AQID")).rejects.toThrow(SubmissionDisabledError);
    }
  });

  it("lets a transfer be prepared from fixture ownership without anything being submitted", async () => {
    const ledger = createFixtureLedger(FIXTURE_EVENTS);
    const submitter = createTransactionSubmitter({ signerConfigured: false, network: "solana-devnet", mainnetEnabled: false });
    const preview = await previewTransfer(
      { asset: FIXTURE_ASSETS.parcelLeaf, from: FIXTURE_WALLETS.buyer, to: FIXTURE_WALLETS.investor, amount: 1n },
      { now: new Date("2026-10-20T19:00:00Z"), mainnetEnabled: false, holders: await ledger.holdersOf(FIXTURE_ASSETS.parcelLeaf), submissionUnavailable: submitter.reason! },
    );
    expect(preview.submission).toEqual({ available: false, reason: "not_enabled" });
    expect(preview.ownershipAsOfSlot).toBe(310_001_500n);
  });
});
