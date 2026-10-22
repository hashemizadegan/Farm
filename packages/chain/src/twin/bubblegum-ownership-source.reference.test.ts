/**
 * Bubblegum V1 ownership history, with instruction data and leaf events built by
 * @metaplex-foundation/mpl-bubblegum (dev-only), so the decoder is checked against the program's own
 * encoding. Transactions are assembled in the getTransaction "json" shape; not recorded from a cluster.
 */
import {
  TokenProgramVersion,
  TokenStandard,
  getBurnInstructionDataSerializer,
  getLeafSchemaSerializer,
  getMintToCollectionV1InstructionDataSerializer,
  getMintV1InstructionDataSerializer,
  getRedeemInstructionDataSerializer,
  getTransferInstructionDataSerializer,
  type MetadataArgsArgs,
} from "@metaplex-foundation/mpl-bubblegum";
import { none, publicKey, some } from "@metaplex-foundation/umi";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { rebuildOwnership, type ChainAssetRef } from "@metafarm/domain";
import { concatBytes, u32le } from "../bytes";
import { BUBBLEGUM_PROGRAM, SPL_NOOP_PROGRAM, leafAssetId } from "../solana/bubblegum";
import { ACCOUNT_COMPRESSION_PROGRAM } from "../solana/compression";
import { anchorDiscriminator, bubblegumOwnershipEvents, combineOwnershipSources, createBubblegumOwnershipSource } from "./bubblegum-ownership-source";
import { createFixtureEventSource } from "./fixture-event-source";
import type { ExecutedInstruction, HistoryTransaction, SolanaHistoryRpc } from "./solana-history-rpc";
import { OwnershipHistoryError, createToken2022OwnershipSource } from "./token2022-ownership-source";

const key = () => Keypair.generate().publicKey.toBase58();
const TREE = key();
const OTHER_TREE = key();
const [AUTH, A, B, C] = [key(), key(), key(), key()] as const;
const NONCE = 7n;
const ASSET_ID = leafAssetId(TREE, NONCE);
const asset: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_BUBBLEGUM_CNFT", id: ASSET_ID };
const zeros = new Uint8Array(32);
const args = (nonce: bigint) => ({ root: zeros, dataHash: zeros, creatorHash: zeros, nonce, index: Number(nonce) });
const metadata: MetadataArgsArgs = {
  name: "Parcel A",
  symbol: "PRCL",
  uri: "https://example.org/a.json",
  sellerFeeBasisPoints: 0,
  primarySaleHappened: false,
  isMutable: true,
  editionNonce: none(),
  tokenStandard: some(TokenStandard.NonFungible),
  collection: none(),
  uses: none(),
  tokenProgramVersion: TokenProgramVersion.Original,
  creators: [],
};

const bg = (accounts: string[], data: Uint8Array): ExecutedInstruction => ({ programId: BUBBLEGUM_PROGRAM, accounts, data });
const mintIx = (tree: string, owner: string) => bg([AUTH, owner, owner, tree, key(), key(), SPL_NOOP_PROGRAM, ACCOUNT_COMPRESSION_PROGRAM, key()], getMintV1InstructionDataSerializer().serialize({ metadata }));
const transferIx = (tree: string, from: string, to: string, nonce = NONCE) =>
  bg([AUTH, from, from, to, tree, SPL_NOOP_PROGRAM, ACCOUNT_COMPRESSION_PROGRAM, key()], getTransferInstructionDataSerializer().serialize(args(nonce)));
const burnIx = (tree: string, from: string, nonce = NONCE) => bg([AUTH, from, from, tree, SPL_NOOP_PROGRAM, ACCOUNT_COMPRESSION_PROGRAM, key()], getBurnInstructionDataSerializer().serialize(args(nonce)));
const redeemIx = (tree: string, from: string, nonce = NONCE) =>
  bg([AUTH, from, from, tree, key(), SPL_NOOP_PROGRAM, ACCOUNT_COMPRESSION_PROGRAM, key()], getRedeemInstructionDataSerializer().serialize(args(nonce)));
/** The noop event a mint emits: ApplicationData(V1(LeafSchemaEvent { type 1, version 0, LeafSchema::V1, leaf hash })). */
const leafEventIx = (assetId: string, owner: string, nonce = NONCE): ExecutedInstruction => {
  const schema = getLeafSchemaSerializer().serialize({ __kind: "V1", id: publicKey(assetId), owner: publicKey(owner), delegate: publicKey(owner), nonce, dataHash: zeros, creatorHash: zeros });
  const event = concatBytes(Uint8Array.of(1, 0), schema, zeros);
  return { programId: SPL_NOOP_PROGRAM, accounts: [], data: concatBytes(Uint8Array.of(1, 0), u32le(event.length), event) };
};
/** The change-log event the compression program also logs through noop (not a leaf event). */
const changeLogIx = (): ExecutedInstruction => ({ programId: SPL_NOOP_PROGRAM, accounts: [], data: Uint8Array.of(0, 0, 1, 2, 3) });
const tx = (instructions: ExecutedInstruction[]) => ({ signature: "s", slot: 5n, txIndex: 0, instructions });
const shape = (es: { kind: string; from: string | null; to: string | null }[]) => es.map((e) => [e.kind, e.from, e.to]);

describe("Bubblegum instruction decoding matches mpl-bubblegum", () => {
  it("uses the program's discriminators", () => {
    const first8 = (b: Uint8Array) => Array.from(b.subarray(0, 8));
    expect(Array.from(anchorDiscriminator("mint_v1"))).toEqual(first8(getMintV1InstructionDataSerializer().serialize({ metadata })));
    expect(Array.from(anchorDiscriminator("mint_to_collection_v1"))).toEqual(first8(getMintToCollectionV1InstructionDataSerializer().serialize({ metadata })));
    expect(Array.from(anchorDiscriminator("transfer"))).toEqual(first8(getTransferInstructionDataSerializer().serialize(args(1n))));
    expect(Array.from(anchorDiscriminator("burn"))).toEqual(first8(getBurnInstructionDataSerializer().serialize(args(1n))));
    expect(Array.from(anchorDiscriminator("redeem"))).toEqual(first8(getRedeemInstructionDataSerializer().serialize(args(1n))));
  });

  it("reads a mint from the leaf event that follows it, a transfer and a burn from the instruction", () => {
    expect(shape(bubblegumOwnershipEvents(asset, TREE, tx([mintIx(TREE, A), leafEventIx(ASSET_ID, A), changeLogIx()])))).toEqual([["mint", null, A]]);
    expect(shape(bubblegumOwnershipEvents(asset, TREE, tx([transferIx(TREE, A, B), leafEventIx(ASSET_ID, B), changeLogIx()])))).toEqual([["transfer", A, B]]);
    expect(shape(bubblegumOwnershipEvents(asset, TREE, tx([burnIx(TREE, B), changeLogIx()])))).toEqual([["burn", B, null]]);
  });

  it("ignores other leaves, other trees, owner-preserving transfers and other programs", () => {
    const otherLeaf = leafAssetId(TREE, 8n);
    expect(bubblegumOwnershipEvents(asset, TREE, tx([mintIx(TREE, A), leafEventIx(otherLeaf, A, 8n)]))).toEqual([]);
    expect(bubblegumOwnershipEvents(asset, TREE, tx([transferIx(TREE, A, B, 8n)]))).toEqual([]);
    expect(bubblegumOwnershipEvents(asset, TREE, tx([transferIx(OTHER_TREE, A, B)]))).toEqual([]);
    expect(bubblegumOwnershipEvents(asset, TREE, tx([transferIx(TREE, A, A)]))).toEqual([]);
    expect(bubblegumOwnershipEvents(asset, TREE, tx([{ programId: key(), accounts: [], data: getTransferInstructionDataSerializer().serialize(args(NONCE)) }]))).toEqual([]);
  });

  it("refuses a redeem of the asset and a mint whose leaf event is missing", () => {
    expect(() => bubblegumOwnershipEvents(asset, TREE, tx([redeemIx(TREE, A)]))).toThrow(OwnershipHistoryError);
    expect(bubblegumOwnershipEvents(asset, TREE, tx([redeemIx(TREE, A, 8n)]))).toEqual([]);
    expect(() => bubblegumOwnershipEvents(asset, TREE, tx([mintIx(TREE, A)]))).toThrow(OwnershipHistoryError);
  });
});

/** A fake node holding one tree's history, newest first. */
function node(finalized: bigint, entries: { s: string; slot: bigint; err?: unknown; ixs: ExecutedInstruction[] }[]): SolanaHistoryRpc {
  const newestFirst = [...entries].reverse();
  const txs = new Map<string, HistoryTransaction>(entries.map((e) => [e.s, { slot: e.slot, err: e.err ?? null, preTokenBalances: [], postTokenBalances: [], instructions: e.ixs }]));
  return {
    getFinalizedSlot: async () => finalized,
    getSignaturesForAddress: async (address, opts) => {
      if (address !== TREE) return [];
      const start = opts.before ? newestFirst.findIndex((e) => e.s === opts.before) + 1 : 0;
      return newestFirst.slice(start, start + opts.limit).map((e) => ({ signature: e.s, slot: e.slot, err: e.err ?? null }));
    },
    getTransaction: async (s) => txs.get(s) ?? null,
  };
}

const history = [
  { s: "m", slot: 100n, ixs: [mintIx(TREE, A), leafEventIx(ASSET_ID, A), changeLogIx()] },
  { s: "x", slot: 300n, err: { InstructionError: [0, "Custom"] }, ixs: [transferIx(TREE, A, C)] },
  { s: "t", slot: 400n, ixs: [transferIx(TREE, A, B), leafEventIx(ASSET_ID, B), changeLogIx()] },
  { s: "o", slot: 450n, ixs: [transferIx(TREE, C, A, 9n)] },
  { s: "b", slot: 900n, ixs: [burnIx(TREE, B), changeLogIx()] },
];

describe("Bubblegum ownership source", () => {
  const treeOf = async (id: string) => (id === ASSET_ID ? TREE : null);

  it("reads the tree's finalized history into the asset's events and stops at the cursor", async () => {
    const src = createBubblegumOwnershipSource(node(500n, history), "solana-devnet", treeOf, { pageSize: 2 });
    expect(src.covers(asset)).toBe(true);
    expect(src.covers({ ...asset, rail: "SOLANA_TOKEN_2022" })).toBe(false);
    const first = await src.eventsAfter(asset, null);
    expect(first.throughSlot).toBe(500n);
    expect(shape(first.events)).toEqual([["mint", null, A], ["transfer", A, B]]);
    expect(rebuildOwnership(first.events).holdings.map((h) => [h.owner, h.amount])).toEqual([[B, 1n]]);
    const later = await createBubblegumOwnershipSource(node(1_000n, history), "solana-devnet", treeOf).eventsAfter(asset, 500n);
    expect(shape(later.events)).toEqual([["burn", B, null]]);
  });

  it("refuses a first window without the asset's mint (wrong tree) and an unknown tree", async () => {
    const wrongTree = async () => OTHER_TREE;
    await expect(createBubblegumOwnershipSource(node(500n, history), "solana-devnet", wrongTree).eventsAfter(asset, null)).rejects.toBeInstanceOf(OwnershipHistoryError);
    await expect(createBubblegumOwnershipSource(node(500n, history), "solana-devnet", async () => null).eventsAfter(asset, null)).rejects.toBeInstanceOf(OwnershipHistoryError);
  });
});

describe("combineOwnershipSources", () => {
  it("routes each asset to the first source that covers it", async () => {
    const token = createToken2022OwnershipSource(node(0n, []), "solana-devnet");
    const bubble = createBubblegumOwnershipSource(node(500n, history), "solana-devnet", async () => TREE);
    const both = combineOwnershipSources(token, bubble);
    expect(both.name).toBe("rpc");
    expect(both.covers(asset)).toBe(true);
    expect(both.covers({ ...asset, network: "solana-mainnet" })).toBe(false);
    expect(shape((await both.eventsAfter(asset, null)).events)).toEqual([["mint", null, A], ["transfer", A, B]]);
    await expect(both.eventsAfter({ ...asset, network: "solana-mainnet" }, null)).rejects.toBeInstanceOf(OwnershipHistoryError);
    expect(combineOwnershipSources(createFixtureEventSource([], 0n)).name).toBe("fixture");
  });

  it("refuses to combine fixture and RPC sources, or nothing (Y0 review F2, D-17)", () => {
    const token = createToken2022OwnershipSource(node(0n, []), "solana-devnet");
    expect(() => combineOwnershipSources(token, createFixtureEventSource([], 0n))).toThrow(OwnershipHistoryError);
    expect(() => combineOwnershipSources(createFixtureEventSource([], 0n), token)).toThrow(OwnershipHistoryError);
    expect(() => combineOwnershipSources()).toThrow(OwnershipHistoryError);
  });
});
