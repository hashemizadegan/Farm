/** Bubblegum minting against a simulated RPC node, and the program's metadata rules. */
import { ed25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import { Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { Ed25519Signer } from "@metafarm/domain";
import { concatBytes, fromBase64, u64le } from "../bytes";
import { base58Decode, base58Encode } from "./base58";
import { BUBBLEGUM_PROGRAM, checkMetadata, hashLeafV1, leafAssetId, metadataHashes, treeConfigAddress, type CompressedMetadata } from "./bubblegum";
import { BubblegumAdapter } from "./bubblegum-adapter";
import { ACCOUNT_COMPRESSION_PROGRAM, planTree, treeAccountSize } from "./compression";
import type { SolanaRpc } from "./rpc";

const seed = new Uint8Array(32).fill(7);
const signer: Ed25519Signer = { address: base58Encode(ed25519.getPublicKey(seed)), signMessage: async (m) => ed25519.sign(m, seed) };
const owner = base58Encode(ed25519.getPublicKey(new Uint8Array(32).fill(9)));
const TREE = base58Encode(ed25519.getPublicKey(new Uint8Array(32).fill(12)));

function treeConfigBytes(o: { creator: string; delegate: string; capacity: bigint; minted: bigint }) {
  return concatBytes(Uint8Array.of(122, 245, 175, 248, 171, 34, 0, 207), base58Decode(o.creator), base58Decode(o.delegate), u64le(o.capacity), u64le(o.minted), Uint8Array.of(0, 1, 0));
}

function fakeRpc(config?: Uint8Array): SolanaRpc {
  return {
    getLatestBlockhash: async () => ({ blockhash: base58Encode(new Uint8Array(32).fill(3)), lastValidBlockHeight: 1_000n }),
    getBlockHeight: async () => 900n,
    getMinimumBalanceForRentExemption: async (space) => BigInt(space) * 6_960n + 890_880n,
    getRecentPrioritizationFees: async () => [],
    sendTransaction: async () => "sig",
    getSignatureStatus: async () => null,
    getAccountInfo: async (address) => (config && address === treeConfigAddress(TREE) ? { owner: BUBBLEGUM_PROGRAM, data: config } : null),
  };
}

const decode = (wire: string) => Transaction.from(Buffer.from(fromBase64(wire)));

describe("Bubblegum adapter", () => {
  it("allocates a private tree sized for its shape and initialises it in one transaction", async () => {
    const plan = planTree(10_000);
    const adapter = new BubblegumAdapter({ network: "solana-devnet", rpc: fakeRpc(), signer, mainnetEnabled: false });
    const p = await adapter.prepareCreateTree({ network: "solana-devnet", maxDepth: plan.maxDepth, maxBufferSize: plan.maxBufferSize, canopyDepth: plan.canopyDepth });
    const tx = decode(p.wire);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.signatures.map((s) => s.publicKey.toBase58())).toEqual([signer.address, p.treeAddress]);
    const [create, init] = tx.instructions.slice(1);
    expect(create!.keys[1]!.pubkey.toBase58()).toBe(p.treeAddress);
    // System CreateAccount: owner is the compression program, space is the tree account size.
    expect(base58Encode(create!.data.subarray(20, 52))).toBe(ACCOUNT_COMPRESSION_PROGRAM);
    expect(Number(Buffer.from(create!.data).readBigUInt64LE(12))).toBe(treeAccountSize(plan.maxDepth, plan.maxBufferSize, plan.canopyDepth));
    expect(init!.programId.toBase58()).toBe(BUBBLEGUM_PROGRAM);
    expect(init!.keys[0]!.pubkey.toBase58()).toBe(treeConfigAddress(p.treeAddress));
    // maxDepth, maxBufferSize, Some(false): a private tree.
    expect([...init!.data.subarray(8)]).toEqual([...new Uint8Array(new Uint32Array([plan.maxDepth, plan.maxBufferSize]).buffer), 1, 0]);
    expect(p.capacity).toBe(16_384n);
  });

  it("mints the next leaf and knows its asset id and leaf hash before sending", async () => {
    const adapter = new BubblegumAdapter({ network: "solana-devnet", rpc: fakeRpc(treeConfigBytes({ creator: signer.address, delegate: signer.address, capacity: 16_384n, minted: 41n })), signer, mainnetEnabled: false });
    const metadata = { name: "Olive tree #1042", symbol: "TREE", uri: "https://example.org/a/1042.json" };
    const p = await adapter.prepareMint({ network: "solana-devnet", merkleTree: TREE, owner, metadata });
    expect(decode(p.wire).verifySignatures()).toBe(true);
    expect(p.leafIndex).toBe(41n);
    expect(p.assetId).toBe(leafAssetId(TREE, 41n));
    const full: CompressedMetadata = { ...metadata, sellerFeeBasisPoints: 0, primarySaleHappened: false, isMutable: true, creators: [{ address: signer.address, verified: true, share: 100 }] };
    expect(p.leafHash).toBe(hashLeafV1({ merkleTree: TREE, leafIndex: 41n, owner, metadata: full }));
    // Recomputed by hand: version 1 ‖ id ‖ owner ‖ delegate ‖ nonce ‖ data hash ‖ creator hash.
    const { dataHash, creatorHash } = metadataHashes(full);
    const node = keccak_256(concatBytes(Uint8Array.of(1), base58Decode(p.assetId), base58Decode(owner), base58Decode(owner), u64le(41n), dataHash, creatorHash));
    expect(p.leafHash).toBe(base58Encode(node));
    expect(p.summary).toMatchObject({ action: "mint_cnft", leafIndex: "41", owner });
  });

  it("refuses trees it cannot mint into, full trees and missing trees", async () => {
    const other = base58Encode(ed25519.getPublicKey(new Uint8Array(32).fill(13)));
    const req = { network: "solana-devnet" as const, merkleTree: TREE, owner, metadata: { name: "x", symbol: "", uri: "" } };
    const foreign = new BubblegumAdapter({ network: "solana-devnet", rpc: fakeRpc(treeConfigBytes({ creator: other, delegate: other, capacity: 8n, minted: 0n })), signer, mainnetEnabled: false });
    await expect(foreign.prepareMint(req)).rejects.toThrow(/may not mint/);
    const full = new BubblegumAdapter({ network: "solana-devnet", rpc: fakeRpc(treeConfigBytes({ creator: signer.address, delegate: signer.address, capacity: 8n, minted: 8n })), signer, mainnetEnabled: false });
    await expect(full.prepareMint(req)).rejects.toThrow(/full/);
    const none = new BubblegumAdapter({ network: "solana-devnet", rpc: fakeRpc(), signer, mainnetEnabled: false });
    await expect(none.prepareMint(req)).rejects.toThrow(/no Bubblegum config/);
    expect(() => new BubblegumAdapter({ network: "solana-mainnet", rpc: fakeRpc(), signer, mainnetEnabled: false })).toThrow(/not enabled/);
  });

  it("reads a tree's on-chain state, the finalized height first", async () => {
    const calls: string[] = [];
    const rpc = (config?: Uint8Array, owner = BUBBLEGUM_PROGRAM): SolanaRpc => ({
      ...fakeRpc(),
      getBlockHeight: async () => (calls.push("height"), 900n),
      getAccountInfo: async (address) => (calls.push("account"), config && address === treeConfigAddress(TREE) ? { owner, data: config } : null),
    });
    const config = treeConfigBytes({ creator: signer.address, delegate: signer.address, capacity: 16_384n, minted: 41n });
    const adapter = new BubblegumAdapter({ network: "solana-devnet", rpc: rpc(config), signer, mainnetEnabled: false });
    expect(await adapter.readTree("solana-devnet", TREE)).toEqual({ finalizedBlockHeight: 900n, tree: { creator: signer.address, numMinted: 41n, capacity: 16_384n } });
    expect(calls).toEqual(["height", "account"]);
    // Never created: no config account.
    expect(await new BubblegumAdapter({ network: "solana-devnet", rpc: rpc(), signer, mainnetEnabled: false }).readTree("solana-devnet", TREE)).toEqual({ finalizedBlockHeight: 900n, tree: null });
    // Something else at that address is not a tree to reason about.
    await expect(new BubblegumAdapter({ network: "solana-devnet", rpc: rpc(config, ACCOUNT_COMPRESSION_PROGRAM), signer, mainnetEnabled: false }).readTree("solana-devnet", TREE)).rejects.toThrow(/not a Bubblegum tree config/);
    await expect(adapter.readTree("solana-mainnet", TREE)).rejects.toThrow(/serves solana-devnet/);
  });

  it("applies the program's metadata limits", () => {
    const ok: CompressedMetadata = { name: "a", symbol: "b", uri: "c", sellerFeeBasisPoints: 0, primarySaleHappened: false, isMutable: true, creators: [] };
    expect(() => checkMetadata(ok)).not.toThrow();
    expect(() => checkMetadata({ ...ok, name: "ز".repeat(17) })).toThrow(/name/); // 34 bytes
    expect(() => checkMetadata({ ...ok, symbol: "ABCDEFGHIJK" })).toThrow(/symbol/);
    expect(() => checkMetadata({ ...ok, uri: "u".repeat(201) })).toThrow(/uri/);
    expect(() => checkMetadata({ ...ok, creators: [{ address: owner, verified: false, share: 99 }] })).toThrow(/add up to 100/);
  });
});

