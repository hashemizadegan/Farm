/**
 * CompressedAssetPort through the Digital Asset Standard (DAS) read API, which indexes compressed
 * NFTs. Indexers lag the chain, so every proof is checked twice before it is handed out: it must
 * hash to the root DAS reports, and that root must be one the on-chain tree still accepts.
 */
import { railOf, type CompressedAssetPort, type CompressedAssetProof, type CompressedAssetRecord, type Network } from "@metafarm/domain";
import { ACCOUNT_COMPRESSION_PROGRAM, parseTreeAccount, rootFromProof } from "./compression";
import type { SolanaRpc } from "./rpc";

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface DasAsset {
  id: string;
  burnt?: boolean;
  ownership: { owner: string; frozen?: boolean };
  compression: { compressed: boolean; tree: string; leaf_id: number };
}

interface DasProof {
  root: string;
  proof: string[];
  node_index: number;
  leaf: string;
  tree_id: string;
}

export class StaleProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleProofError";
  }
}

/** A program error that means the proof was out of date when the transaction ran; fetch a new one and retry. */
export function isStaleProofError(message: string): boolean {
  return /invalid root recomputed from proof|leaf contents do not match|concurrent ?merkle ?tree ?error|0x1771/i.test(message);
}

export class DasCompressedAssetAdapter implements CompressedAssetPort {
  private id = 0;

  constructor(
    private readonly cfg: {
      network: Network;
      /** A DAS-enabled RPC endpoint (most providers need an API key in the URL). */
      dasUrl: string;
      /** For reading the tree account. */
      rpc: SolanaRpc;
      fetchImpl?: Fetch;
      /** Attempts to get a proof the chain accepts before giving up. */
      attempts?: number;
    },
  ) {
    if (railOf(cfg.network) !== "solana") throw new Error(`${cfg.network} is not a Solana network`);
  }

  async getAsset(network: Network, assetId: string): Promise<CompressedAssetRecord | null> {
    this.check(network);
    let a: DasAsset;
    try {
      a = await this.call<DasAsset>("getAsset", { id: assetId });
    } catch (err) {
      if (/not found/i.test((err as Error).message)) return null;
      throw err;
    }
    if (!a?.compression) return null;
    return {
      id: a.id,
      owner: a.ownership.owner,
      tree: a.compression.tree,
      leafIndex: a.compression.leaf_id,
      compressed: a.compression.compressed,
      burnt: a.burnt ?? false,
      frozen: a.ownership.frozen ?? false,
    };
  }

  async getAssetProof(network: Network, assetId: string): Promise<CompressedAssetProof> {
    this.check(network);
    const attempts = this.cfg.attempts ?? 3;
    let last = "";
    for (let i = 0; i < attempts; i++) {
      const p = await this.call<DasProof>("getAssetProof", { id: assetId });
      const leafIndex = p.node_index - 2 ** p.proof.length;
      if (leafIndex < 0) throw new Error("DAS returned an inconsistent node index");
      if (rootFromProof(p.leaf, p.proof, leafIndex) !== p.root) {
        last = "the proof does not hash to the root DAS reported";
        continue;
      }
      const account = await this.cfg.rpc.getAccountInfo(p.tree_id);
      if (!account || account.owner !== ACCOUNT_COMPRESSION_PROGRAM) throw new Error(`${p.tree_id} is not a compression tree`);
      const tree = parseTreeAccount(account.data);
      if (tree.maxDepth !== p.proof.length) throw new Error("proof length does not match the tree depth");
      if (!tree.recentRoots.includes(p.root)) {
        last = "the indexer is behind the chain: its root is no longer accepted";
        continue;
      }
      return { root: p.root, proof: p.proof, leaf: p.leaf, nodeIndex: p.node_index, tree: p.tree_id };
    }
    throw new StaleProofError(`no usable proof for ${assetId} after ${attempts} attempts: ${last}`);
  }

  private check(network: Network) {
    if (network !== this.cfg.network) throw new Error(`this adapter serves ${this.cfg.network}, not ${network}`);
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const fetchImpl = this.cfg.fetchImpl ?? (fetch as unknown as Fetch);
    const res = await fetchImpl(this.cfg.dasUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    if (!res.ok) throw new Error(`DAS ${method} returned HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`DAS ${method}: ${body.error.message}`);
    return body.result as T;
  }
}
