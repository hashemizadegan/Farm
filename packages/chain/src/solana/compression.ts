/**
 * Concurrent Merkle trees (SPL Account Compression), which hold Bubblegum compressed NFTs: sizing a
 * tree for a number of assets, reading a tree account, and checking proofs locally.
 * Nodes hash as keccak256(left ‖ right).
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes } from "../bytes";
import { base58Decode, base58Encode } from "./base58";

export const ACCOUNT_COMPRESSION_PROGRAM = "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK";

/** Depth / buffer-size pairs the program accepts. */
export const VALID_DEPTH_BUFFER_PAIRS: readonly { maxDepth: number; maxBufferSize: number }[] = [
  [3, 8], [5, 8], [6, 16], [7, 16], [8, 16], [9, 16], [10, 32], [11, 32], [12, 32], [13, 32],
  [14, 64], [14, 256], [14, 1024], [14, 2048], [15, 64], [16, 64], [17, 64], [18, 64], [19, 64],
  [20, 64], [20, 256], [20, 1024], [20, 2048], [24, 64], [24, 256], [24, 512], [24, 1024], [24, 2048],
  [26, 512], [26, 1024], [26, 2048], [30, 512], [30, 1024], [30, 2048],
].map(([maxDepth, maxBufferSize]) => ({ maxDepth: maxDepth!, maxBufferSize: maxBufferSize! }));

/** Account type + header version + V1 header (buffer size, depth, authority, creation slot, flag, padding). */
export const TREE_HEADER_SIZE = 2 + 4 + 4 + 32 + 8 + 1 + 5;
/** Deepest canopy an account can hold. */
export const MAX_CANOPY_DEPTH = 17;

const changeLogSize = (maxDepth: number) => 32 + 32 * maxDepth + 4 + 4;
const pathSize = (maxDepth: number) => 32 * maxDepth + 32 + 4 + 4;

export const treeBodySize = (maxDepth: number, maxBufferSize: number) => 8 + 8 + 8 + maxBufferSize * changeLogSize(maxDepth) + pathSize(maxDepth);
export const canopySize = (canopyDepth: number) => Math.max((1 << (canopyDepth + 1)) - 2, 0) * 32;

export function treeAccountSize(maxDepth: number, maxBufferSize: number, canopyDepth = 0): number {
  if (!VALID_DEPTH_BUFFER_PAIRS.some((p) => p.maxDepth === maxDepth && p.maxBufferSize === maxBufferSize)) throw new Error(`${maxDepth}/${maxBufferSize} is not a valid tree shape`);
  if (canopyDepth < 0 || canopyDepth > Math.min(MAX_CANOPY_DEPTH, maxDepth)) throw new Error("canopy depth out of range");
  return TREE_HEADER_SIZE + treeBodySize(maxDepth, maxBufferSize) + canopySize(canopyDepth);
}

export interface TreePlan {
  maxDepth: number;
  maxBufferSize: number;
  canopyDepth: number;
  /** Leaves the tree can ever hold. */
  capacity: number;
  accountSize: number;
  /** Proof accounts each transfer or burn must carry (depth minus canopy). */
  proofAccounts: number;
}

/**
 * The smallest tree that holds `assets` leaves with at least `concurrency` changes per slot, with
 * a canopy deep enough that a transfer carries at most `maxProofAccounts` proof accounts
 * (so it composes with other instructions within one transaction).
 */
export function planTree(assets: number, o: { concurrency?: number; maxProofAccounts?: number } = {}): TreePlan {
  if (!Number.isInteger(assets) || assets < 1) throw new RangeError("plan for at least one asset");
  const concurrency = o.concurrency ?? 64;
  const maxProof = o.maxProofAccounts ?? 8;
  const shape = VALID_DEPTH_BUFFER_PAIRS.find((p) => 2 ** p.maxDepth >= assets && p.maxBufferSize >= concurrency);
  if (!shape) throw new RangeError(`no tree shape holds ${assets} assets at concurrency ${concurrency}`);
  const canopyDepth = Math.min(Math.max(shape.maxDepth - maxProof, 0), MAX_CANOPY_DEPTH);
  return {
    ...shape,
    canopyDepth,
    capacity: 2 ** shape.maxDepth,
    accountSize: treeAccountSize(shape.maxDepth, shape.maxBufferSize, canopyDepth),
    proofAccounts: shape.maxDepth - canopyDepth,
  };
}

export interface TreeAccount {
  maxDepth: number;
  maxBufferSize: number;
  authority: string;
  creationSlot: bigint;
  sequenceNumber: bigint;
  canopyDepth: number;
  /** Roots the program will still accept for a proof, newest first. */
  recentRoots: string[];
}

/** Reads a concurrent Merkle tree account (V1 header). */
export function parseTreeAccount(data: Uint8Array): TreeAccount {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < TREE_HEADER_SIZE || data[0] !== 1) throw new Error("not a concurrent Merkle tree account");
  if (data[1] !== 0) throw new Error(`unsupported tree header version ${data[1]}`);
  const maxBufferSize = view.getUint32(2, true);
  const maxDepth = view.getUint32(6, true);
  const authority = base58Encode(data.subarray(10, 42));
  const creationSlot = view.getBigUint64(42, true);
  const body = TREE_HEADER_SIZE;
  const bodySize = treeBodySize(maxDepth, maxBufferSize);
  if (data.length < body + bodySize) throw new Error("tree account is too short for its shape");
  const sequenceNumber = view.getBigUint64(body, true);
  const activeIndex = Number(view.getBigUint64(body + 8, true));
  const bufferSize = Number(view.getBigUint64(body + 16, true));
  const logs = body + 24;
  const recentRoots: string[] = [];
  for (let i = 0; i < Math.min(bufferSize, maxBufferSize); i++) {
    const at = logs + ((activeIndex - i + maxBufferSize) % maxBufferSize) * changeLogSize(maxDepth);
    recentRoots.push(base58Encode(data.subarray(at, at + 32)));
  }
  const canopyBytes = data.length - body - bodySize;
  let canopyDepth = 0;
  while (canopySize(canopyDepth + 1) <= canopyBytes && canopyDepth < MAX_CANOPY_DEPTH) canopyDepth++;
  return { maxDepth, maxBufferSize, authority, creationSlot, sequenceNumber, canopyDepth, recentRoots };
}

const hashPair = (left: Uint8Array, right: Uint8Array) => keccak_256(concatBytes(left, right));

/** The root a leaf and its proof (siblings from the leaf upwards) imply. */
export function rootFromProof(leaf: string, proof: string[], leafIndex: number): string {
  let node = base58Decode(leaf);
  let index = leafIndex;
  for (const sibling of proof) {
    const s = base58Decode(sibling);
    node = index % 2 === 0 ? hashPair(node, s) : hashPair(s, node);
    index = Math.floor(index / 2);
  }
  return base58Encode(node);
}

