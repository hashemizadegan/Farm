/** CompressedIssuancePort on Metaplex Bubblegum V1: allocate private trees and mint compressed NFTs. */
import {
  networkAllowed,
  railOf,
  type CompressedIssuancePort,
  type CompressedMintRequest,
  type CompressedTreeState,
  type CreateTreeRequest,
  type Ed25519Signer,
  type Network,
} from "@metafarm/domain";
import { BUBBLEGUM_PROGRAM, createTreeConfig, hashLeafV1, leafAssetId, mintV1, parseTreeConfig, treeConfigAddress, type CompressedMetadata } from "./bubblegum";
import { ACCOUNT_COMPRESSION_PROGRAM, treeAccountSize } from "./compression";
import { createAccount } from "./instructions";
import { ephemeralKeypair, isSolanaAddress } from "./keys";
import { prepareSolanaTransaction } from "./prepare";
import type { SolanaRpc } from "./rpc";

export interface BubblegumAdapterConfig {
  network: Network;
  rpc: SolanaRpc;
  /** Fee payer, tree creator (so the only one who can mint) and the leaves' verified creator. */
  signer: Ed25519Signer;
  mainnetEnabled: boolean;
  maxPriorityFeeMicroLamports?: bigint;
  /** For tests: deterministic tree keys. */
  random?: (n: number) => Uint8Array;
}

/** Initialising a tree touches every node of its first path; deeper trees need more. */
const CREATE_TREE_COMPUTE_UNITS = 400_000;
const MINT_COMPUTE_UNITS = 150_000;

export class BubblegumAdapter implements CompressedIssuancePort {
  private readonly feeCap: bigint;

  constructor(private readonly cfg: BubblegumAdapterConfig) {
    if (railOf(cfg.network) !== "solana") throw new Error(`${cfg.network} is not a Solana network`);
    if (!networkAllowed(cfg.network, { mainnetEnabled: cfg.mainnetEnabled })) throw new Error(`${cfg.network} is not enabled for issuance`);
    this.feeCap = cfg.maxPriorityFeeMicroLamports ?? 1_000_000n;
  }

  async prepareCreateTree(r: CreateTreeRequest) {
    this.checkNetwork(r.network);
    const space = treeAccountSize(r.maxDepth, r.maxBufferSize, r.canopyDepth);
    const tree = ephemeralKeypair(this.cfg.random);
    const lamports = await this.cfg.rpc.getMinimumBalanceForRentExemption(space);
    const me = this.cfg.signer.address;
    const prepared = await this.finish(
      CREATE_TREE_COMPUTE_UNITS,
      [
        createAccount({ from: me, newAccount: tree.address, lamports, space, owner: ACCOUNT_COMPRESSION_PROGRAM }),
        createTreeConfig({ merkleTree: tree.address, payer: me, treeCreator: me, maxDepth: r.maxDepth, maxBufferSize: r.maxBufferSize, public: false }),
      ],
      [tree.address, treeConfigAddress(tree.address)],
      new Map([[tree.address, tree.sign]]),
      {
        action: "create_tree",
        tree: tree.address,
        maxDepth: r.maxDepth,
        maxBufferSize: r.maxBufferSize,
        canopyDepth: r.canopyDepth,
        space,
        rentLamports: lamports.toString(),
      },
    );
    return { ...prepared, treeAddress: tree.address, capacity: 1n << BigInt(r.maxDepth) };
  }

  async prepareMint(r: CompressedMintRequest) {
    this.checkNetwork(r.network);
    if (!isSolanaAddress(r.merkleTree) || !isSolanaAddress(r.owner)) throw new Error("tree and owner must be Solana addresses");
    const me = this.cfg.signer.address;
    const account = await this.cfg.rpc.getAccountInfo(treeConfigAddress(r.merkleTree));
    if (!account) throw new Error(`tree ${r.merkleTree} has no Bubblegum config`);
    const config = parseTreeConfig(account.data);
    if (config.treeCreator !== me && config.treeDelegate !== me) throw new Error("the platform signer may not mint into this tree");
    if (config.numMinted >= config.totalMintCapacity) throw new Error("the tree is full");
    const metadata: CompressedMetadata = {
      ...r.metadata,
      sellerFeeBasisPoints: 0,
      primarySaleHappened: false,
      isMutable: true,
      creators: [{ address: me, verified: true, share: 100 }],
    };
    const leafIndex = config.numMinted;
    const prepared = await this.finish(MINT_COMPUTE_UNITS, [mintV1({ merkleTree: r.merkleTree, leafOwner: r.owner, payer: me, treeDelegate: me, metadata })], [r.merkleTree, treeConfigAddress(r.merkleTree)], new Map(), {
      action: "mint_cnft",
      tree: r.merkleTree,
      owner: r.owner,
      leafIndex: leafIndex.toString(),
      name: r.metadata.name,
      uri: r.metadata.uri,
    });
    return {
      ...prepared,
      leafIndex,
      assetId: leafAssetId(r.merkleTree, leafIndex),
      leafHash: hashLeafV1({ merkleTree: r.merkleTree, leafIndex, owner: r.owner, metadata }),
    };
  }

  async readTree(network: Network, merkleTree: string): Promise<CompressedTreeState> {
    this.checkNetwork(network);
    if (!isSolanaAddress(merkleTree)) throw new Error("not a Solana address");
    // Height first, so the account state read afterwards is at least as recent.
    const finalizedBlockHeight = await this.cfg.rpc.getBlockHeight();
    const account = await this.cfg.rpc.getAccountInfo(treeConfigAddress(merkleTree));
    if (!account) return { finalizedBlockHeight, tree: null };
    if (account.owner !== BUBBLEGUM_PROGRAM) throw new Error(`${treeConfigAddress(merkleTree)} is not a Bubblegum tree config`);
    const c = parseTreeConfig(account.data);
    return { finalizedBlockHeight, tree: { creator: c.treeCreator, numMinted: c.numMinted, capacity: c.totalMintCapacity } };
  }

  private checkNetwork(network: Network) {
    if (network !== this.cfg.network) throw new Error(`this adapter serves ${this.cfg.network}, not ${network}`);
  }

  private finish(units: number, body: Parameters<typeof prepareSolanaTransaction>[0]["body"], writable: string[], extraSigners: Map<string, (m: Uint8Array) => Promise<Uint8Array>>, summary: Record<string, unknown>) {
    const { network, rpc, signer } = this.cfg;
    return prepareSolanaTransaction({ network, rpc, signer, computeUnitLimit: units, feeCap: this.feeCap, body, writable, extraSigners, summary });
  }
}

