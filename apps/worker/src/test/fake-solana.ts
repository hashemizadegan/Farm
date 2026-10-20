/**
 * A scripted Solana devnet for engine tests (shared by the compressed-NFT engine and fault tests).
 * Test-only: never imported by the worker's entry point.
 */
import type {
  AssetIssuancePort,
  ChainObservation,
  ChainObservationPort,
  CompressedAssetPort,
  CompressedAssetRecord,
  CompressedIssuancePort,
  CompressedMintRequest,
  PreparedTransaction,
} from "@metafarm/domain";

export const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const b58 = (n = 40) => Array.from({ length: n }, () => B58[Math.floor(Math.random() * B58.length)]).join("");

/**
 * One scripted Solana devnet: which trees exist on chain with how many leaves, what each sent
 * transaction is observed as, and what DAS has indexed. What a transaction does on chain (a tree
 * created, a leaf appended) happens only if it lands, which is usually when it is observed final;
 * `leaveSentTransactions(status, { lands: true })` makes a transaction land while it is observed
 * otherwise: a confirmation that was missed. Only this chain's own transactions are touched.
 */
export function fakeChain() {
  const fate = new Map<string, ChainObservation["status"]>();
  /** What sent transactions are observed as, and whether they land on chain. */
  let onSend: { status: ChainObservation["status"]; lands: boolean } = { status: "final", lands: true };
  const own = new Set<string>();
  const effects = new Map<string, () => void>();
  const onChain = new Map<string, { creator: string; numMinted: bigint }>();
  const leaves = new Map<string, { tree: string; leafIndex: bigint; leafHash: string }>();
  const trees: string[] = [];
  const mints: CompressedMintRequest[] = [];
  const indexed = new Map<string, CompressedAssetRecord>();
  const creator = b58();
  const knobs = {
    /** Finalized block height: past every prepared transaction's validity (1000) unless lowered. */
    finalizedHeight: 2_000n,
    rpcDown: false,
    staleProof: false,
    /** Makes DAS's proof carry a different leaf hash. */
    proofLeaf: undefined as string | undefined,
  };
  const prepared = (txRef: string, summary: Record<string, unknown>): PreparedTransaction => {
    own.add(txRef);
    return {
      network: "solana-devnet",
      txRef,
      wire: Buffer.from(txRef).toString("base64"),
      validity: { lastValidBlockHeight: 1_000n },
      fees: { priorityFeeMicroLamports: 1n, computeUnitLimit: 1 },
      summary,
    };
  };
  const compressed: CompressedIssuancePort = {
    prepareCreateTree: async (r) => {
      const treeAddress = b58();
      trees.push(treeAddress);
      const tx = prepared(`tree-${b58(20)}`, { action: "create_tree", tree: treeAddress });
      effects.set(tx.txRef, () => onChain.set(treeAddress, { creator, numMinted: 0n }));
      return { ...tx, treeAddress, capacity: 1n << BigInt(r.maxDepth) };
    },
    prepareMint: async (r) => {
      const tree = onChain.get(r.merkleTree);
      if (!tree) throw new Error(`tree ${r.merkleTree} has no Bubblegum config`);
      mints.push(r);
      const leafIndex = tree.numMinted;
      const tx = prepared(`mint-${b58(20)}`, { action: "mint_cnft" });
      effects.set(tx.txRef, () => (tree.numMinted += 1n));
      const assetId = b58();
      const leafHash = b58(44);
      leaves.set(assetId, { tree: r.merkleTree, leafIndex, leafHash });
      return { ...tx, assetId, leafIndex, leafHash };
    },
    readTree: async (_n, merkleTree) => {
      if (knobs.rpcDown) throw new Error("RPC unavailable");
      const t = onChain.get(merkleTree);
      return { finalizedBlockHeight: knobs.finalizedHeight, tree: t ? { creator: t.creator, numMinted: t.numMinted, capacity: 8n } : null };
    },
  };
  const observer: ChainObservationPort = {
    submit: async (p) => {
      if (!own.has(p.txRef)) return; // another chain's transaction (the engine drives every workspace)
      if (!fate.has(p.txRef)) {
        fate.set(p.txRef, onSend.status);
        if (onSend.lands) {
          effects.get(p.txRef)?.();
          effects.delete(p.txRef);
        }
      }
    },
    observe: async (t) => ({ status: (own.has(t.txRef) && fate.get(t.txRef)) || "not_found", slotOrBlock: 99n }),
  };
  const assets: CompressedAssetPort = {
    getAsset: async (_n, id) => indexed.get(id) ?? null,
    getAssetProof: async (_n, id) => {
      if (knobs.staleProof) throw new Error("no usable proof: the indexer is behind the chain");
      const l = leaves.get(id);
      if (!l) throw new Error("not found");
      // Depth 3: node index = 2^3 + leaf index.
      return { root: b58(44), proof: [b58(44), b58(44), b58(44)], leaf: knobs.proofLeaf ?? l.leafHash, nodeIndex: 8 + Number(l.leafIndex), tree: l.tree };
    },
  };
  const unused: AssetIssuancePort = {
    prepareCreateMint: async () => {
      throw new Error("not used");
    },
    prepareIssuance: async () => {
      throw new Error("not used");
    },
  };
  return {
    rails: {
      solana: {
        network: "solana-devnet" as const,
        issuance: unused,
        observer,
        compressed: {
          issuance: compressed,
          assets,
          creator,
          treeShape: { maxDepth: 3, maxBufferSize: 8, canopyDepth: 0, capacity: 8 },
        },
      },
    },
    fate,
    trees,
    mints,
    indexed,
    onChain,
    knobs,
    leaveSentTransactions: (status: ChainObservation["status"], o: { lands?: boolean } = {}) =>
      (onSend = { status, lands: o.lands ?? status === "final" }),
  };
}

export type FakeChain = ReturnType<typeof fakeChain>;
