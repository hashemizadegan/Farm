/** Tree sizing, tree-account reading and proofs, checked against @solana/spl-account-compression (dev-only). */
import { keccak_256 } from "@noble/hashes/sha3";
import { ALL_DEPTH_SIZE_PAIRS, ConcurrentMerkleTreeAccount, getConcurrentMerkleTreeAccountSize } from "@solana/spl-account-compression";
import { describe, expect, it } from "vitest";
import { concatBytes, utf8 } from "../bytes";
import { base58Encode } from "./base58";
import { ACCOUNT_COMPRESSION_PROGRAM, VALID_DEPTH_BUFFER_PAIRS, parseTreeAccount, planTree, rootFromProof, treeAccountSize } from "./compression";
import { DasCompressedAssetAdapter, StaleProofError, isStaleProofError } from "./das-adapter";
import type { SolanaRpc } from "./rpc";

/** Bytes of a tree account with these recent roots (oldest first). */
function treeAccount(o: { maxDepth: number; maxBufferSize: number; canopyDepth?: number; roots: Uint8Array[]; authority?: Uint8Array }) {
  const b = new Uint8Array(treeAccountSize(o.maxDepth, o.maxBufferSize, o.canopyDepth ?? 0));
  const v = new DataView(b.buffer);
  b[0] = 1;
  b[1] = 0;
  v.setUint32(2, o.maxBufferSize, true);
  v.setUint32(6, o.maxDepth, true);
  b.set(o.authority ?? new Uint8Array(32).fill(4), 10);
  v.setBigUint64(42, 123n, true);
  const body = 56;
  v.setBigUint64(body, BigInt(o.roots.length), true);
  v.setBigUint64(body + 8, BigInt(o.roots.length - 1), true);
  v.setBigUint64(body + 16, BigInt(o.roots.length), true);
  o.roots.forEach((r, i) => b.set(r, body + 24 + i * (32 + 32 * o.maxDepth + 8)));
  return b;
}

/** A full binary tree of depth 3 over eight leaves, with each leaf's proof. */
function smallTree() {
  const leaves = Array.from({ length: 8 }, (_, i) => keccak_256(utf8(`leaf-${i}`)));
  const levels: Uint8Array[][] = [leaves];
  while (levels.at(-1)!.length > 1) {
    const prev = levels.at(-1)!;
    levels.push(Array.from({ length: prev.length / 2 }, (_, i) => keccak_256(concatBytes(prev[2 * i]!, prev[2 * i + 1]!))));
  }
  const proofOf = (index: number) => levels.slice(0, -1).map((level, d) => base58Encode(level[(index >> d) ^ 1]!));
  return { leaves, root: levels.at(-1)![0]!, proofOf };
}

describe("concurrent Merkle trees match the reference library", () => {
  it("accepts the same shapes", () => {
    expect(VALID_DEPTH_BUFFER_PAIRS).toEqual(ALL_DEPTH_SIZE_PAIRS.map((p) => ({ maxDepth: p.maxDepth, maxBufferSize: p.maxBufferSize })));
  });

  it("sizes accounts identically, with and without a canopy", () => {
    for (const { maxDepth, maxBufferSize } of VALID_DEPTH_BUFFER_PAIRS) {
      for (const canopy of [0, 1, Math.min(maxDepth, 10)]) {
        expect(treeAccountSize(maxDepth, maxBufferSize, canopy)).toBe(getConcurrentMerkleTreeAccountSize(maxDepth, maxBufferSize, canopy));
      }
    }
  });

  it("reads a tree account the way the library does", () => {
    const roots = [1, 2, 3].map((n) => keccak_256(utf8(`root-${n}`)));
    const bytes = treeAccount({ maxDepth: 14, maxBufferSize: 64, canopyDepth: 3, roots });
    const ours = parseTreeAccount(bytes);
    const ref = ConcurrentMerkleTreeAccount.fromBuffer(Buffer.from(bytes));
    expect(ours.maxDepth).toBe(ref.getMaxDepth());
    expect(ours.maxBufferSize).toBe(ref.getMaxBufferSize());
    expect(ours.canopyDepth).toBe(ref.getCanopyDepth());
    expect(ours.authority).toBe(ref.getAuthority().toBase58());
    expect(ours.recentRoots[0]).toBe(base58Encode(ref.getCurrentRoot()));
    expect(ours.recentRoots).toEqual([roots[2], roots[1], roots[0]].map((r) => base58Encode(r!)));
  });
});

describe("tree planning", () => {
  it("picks the smallest shape and a canopy that keeps transfers composable", () => {
    expect(planTree(1_000)).toMatchObject({ maxDepth: 14, maxBufferSize: 64, canopyDepth: 6, capacity: 16_384, proofAccounts: 8 });
    expect(planTree(1_000_000)).toMatchObject({ maxDepth: 20, maxBufferSize: 64, canopyDepth: 12, proofAccounts: 8 });
    expect(planTree(5, { concurrency: 8 })).toMatchObject({ maxDepth: 3, maxBufferSize: 8, canopyDepth: 0, proofAccounts: 3 });
    expect(planTree(100_000, { concurrency: 1_024, maxProofAccounts: 4 })).toMatchObject({ maxDepth: 20, maxBufferSize: 1_024, canopyDepth: 16, proofAccounts: 4 });
    expect(() => planTree(2 ** 30 + 1)).toThrow(/no tree shape/);
    expect(planTree(1_000).accountSize).toBe(getConcurrentMerkleTreeAccountSize(14, 64, 6));
  });
});

describe("proofs", () => {
  it("recomputes the root from any leaf, and not from a wrong one", () => {
    const t = smallTree();
    for (let i = 0; i < 8; i++) expect(rootFromProof(base58Encode(t.leaves[i]!), t.proofOf(i), i)).toBe(base58Encode(t.root));
    expect(rootFromProof(base58Encode(t.leaves[1]!), t.proofOf(2), 2)).not.toBe(base58Encode(t.root));
  });

  it("recognises stale-proof failures", () => {
    expect(isStaleProofError("Program log: Error: Invalid root recomputed from proof")).toBe(true);
    expect(isStaleProofError("custom program error: 0x1771")).toBe(true);
    expect(isStaleProofError("insufficient funds")).toBe(false);
  });
});

describe("DAS adapter", () => {
  const t = smallTree();
  const TREE = base58Encode(new Uint8Array(32).fill(8));
  const ASSET = base58Encode(new Uint8Array(32).fill(6));
  const proofFor = (index: number, root = t.root) => ({ root: base58Encode(root), proof: t.proofOf(index), node_index: 8 + index, leaf: base58Encode(t.leaves[index]!), tree_id: TREE });

  function setup(o: { proofs: object[]; chainRoots: Uint8Array[]; asset?: object | null }) {
    let n = 0;
    const das = async (_url: string, init: { body: string }) => {
      const { method, id } = JSON.parse(init.body) as { method: string; id: number };
      if (method === "getAssetProof") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result: o.proofs[Math.min(n++, o.proofs.length - 1)] }) };
      if (o.asset === null) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "Asset Not Found" } }) };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result: o.asset }) };
    };
    const rpc = {
      getAccountInfo: async () => ({ owner: ACCOUNT_COMPRESSION_PROGRAM, data: treeAccount({ maxDepth: 3, maxBufferSize: 8, roots: o.chainRoots }) }),
    } as unknown as SolanaRpc;
    return { adapter: new DasCompressedAssetAdapter({ network: "solana-devnet", dasUrl: "https://das.example", rpc, fetchImpl: das }), calls: () => n };
  }

  it("hands out a proof only when it hashes to a root the tree still accepts", async () => {
    const { adapter } = setup({ proofs: [proofFor(5)], chainRoots: [keccak_256(utf8("older")), t.root] });
    expect(await adapter.getAssetProof("solana-devnet", ASSET)).toMatchObject({ root: base58Encode(t.root), nodeIndex: 13, tree: TREE });
  });

  it("asks again when a proof does not add up or the indexer is behind, then gives up", async () => {
    // First answer: a leaf that does not belong to that path. Second: a good proof.
    const broken = { ...proofFor(5), leaf: base58Encode(t.leaves[4]!) };
    const recovered = setup({ proofs: [broken, proofFor(5)], chainRoots: [t.root] });
    expect(await recovered.adapter.getAssetProof("solana-devnet", ASSET)).toMatchObject({ root: base58Encode(t.root) });
    expect(recovered.calls()).toBe(2);
    // The indexer's root is consistent but the chain has moved on.
    const lagging = setup({ proofs: [proofFor(5)], chainRoots: [keccak_256(utf8("newer"))] });
    await expect(lagging.adapter.getAssetProof("solana-devnet", ASSET)).rejects.toBeInstanceOf(StaleProofError);
    expect(lagging.calls()).toBe(3);
  });

  it("reads assets and reports missing ones as null", async () => {
    const asset = { id: ASSET, burnt: false, ownership: { owner: "Owner1111111111111111111111111111111111111", frozen: true }, compression: { compressed: true, tree: TREE, leaf_id: 5 } };
    expect(await setup({ proofs: [], chainRoots: [t.root], asset }).adapter.getAsset("solana-devnet", ASSET)).toEqual({
      id: ASSET,
      owner: "Owner1111111111111111111111111111111111111",
      tree: TREE,
      leafIndex: 5,
      compressed: true,
      burnt: false,
      frozen: true,
    });
    expect(await setup({ proofs: [], chainRoots: [t.root], asset: null }).adapter.getAsset("solana-devnet", ASSET)).toBeNull();
    await expect(setup({ proofs: [], chainRoots: [] }).adapter.getAsset("solana-mainnet", ASSET)).rejects.toThrow(/serves solana-devnet/);
  });
});
