/**
 * Verifiable off-chain data: content hashes, commitments to canonical records, and Merkle batches
 * of commitments.
 *
 * Off-chain data (telemetry, GIS layers, media, operational records) stays off-chain, but each item
 * is identified by the SHA-256 of its exact bytes or of its canonical JSON, and items are grouped
 * into Merkle batches whose root can later be written on-chain. Anyone holding an item, its proof
 * and the root can check the item was part of the batch without trusting the database.
 *
 * The Merkle tree follows RFC 9162 (Certificate Transparency v2), section 2.1: leaves are hashed as
 * SHA-256(0x00 ‖ data) and interior nodes as SHA-256(0x01 ‖ left ‖ right), so a leaf can never be
 * passed off as a node, and batches of any size (not only powers of two) have one defined root.
 * Here a leaf's data is the 32 bytes of the item's content hash.
 *
 * Works in browsers and Node (Web Crypto); no blockchain SDK is involved.
 */
import { canonicalJson } from "../harvest";

/** Identifies how batch roots are computed, so a verifier can recompute them. */
export const MERKLE_SCHEME = "metafarm-merkle-sha256/1";
/** Identifies how record commitments are computed. */
export const RECORD_COMMITMENT_SCHEME = "metafarm-record/1";
/** Largest batch the platform builds in one go. */
export const MAX_BATCH_LEAVES = 4096;

const HEX64 = /^[0-9a-f]{64}$/;
const SCHEMA_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A lowercase hex SHA-256 digest. */
export const isSha256Hex = (s: unknown): s is string => typeof s === "string" && HEX64.test(s);

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

async function digest(parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", buf));
}

/** SHA-256 (hex) of bytes, or of a string's UTF-8 encoding. */
export async function contentHash(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return toHex(await digest([bytes]));
}

export interface RecordCommitment {
  scheme: typeof RECORD_COMMITMENT_SCHEME;
  /** Name of the record's schema, e.g. `metafarm.harvest-lot`. */
  schema: string;
  schemaVersion: number;
  /** SHA-256 (hex) of the canonical JSON of `{ scheme, schema, schemaVersion, record }`. */
  sha256: string;
}

/**
 * Commits to a structured record: the hash covers the schema name and version as well as the
 * record, so the same facts under another schema version give another hash.
 */
export async function commitToRecord(schema: string, schemaVersion: number, record: unknown): Promise<RecordCommitment> {
  if (!SCHEMA_NAME.test(schema)) throw new RangeError("schema must be 1-64 lowercase letters, digits, '.', '_' or '-'");
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new RangeError("schemaVersion must be a positive integer");
  const sha256 = await contentHash(canonicalJson({ scheme: RECORD_COMMITMENT_SCHEME, schema, schemaVersion, record }));
  return { scheme: RECORD_COMMITMENT_SCHEME, schema, schemaVersion, sha256 };
}

const LEAF_PREFIX = Uint8Array.of(0);
const NODE_PREFIX = Uint8Array.of(1);

/** The Merkle leaf for an item whose content hash is `contentSha256`. */
export async function merkleLeaf(contentSha256: string): Promise<string> {
  if (!isSha256Hex(contentSha256)) throw new RangeError("content hash must be 64 lowercase hex characters");
  return toHex(await digest([LEAF_PREFIX, fromHex(contentSha256)]));
}

async function node(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return digest([NODE_PREFIX, left, right]);
}

/** Largest power of two strictly below n (n ≥ 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

async function subtreeHash(leaves: Uint8Array[], lo: number, hi: number): Promise<Uint8Array> {
  if (hi - lo === 1) return leaves[lo]!;
  const k = split(hi - lo);
  return node(await subtreeHash(leaves, lo, lo + k), await subtreeHash(leaves, lo + k, hi));
}

function checkLeaves(leaves: readonly string[]): Uint8Array[] {
  if (leaves.length === 0) throw new RangeError("a batch needs at least one leaf");
  if (leaves.length > MAX_BATCH_LEAVES) throw new RangeError(`a batch holds at most ${MAX_BATCH_LEAVES} leaves`);
  return leaves.map((l) => {
    if (!isSha256Hex(l)) throw new RangeError("leaf hashes must be 64 lowercase hex characters");
    return fromHex(l);
  });
}

/** The root of a batch, given its leaf hashes (from `merkleLeaf`) in batch order. */
export async function merkleRoot(leaves: readonly string[]): Promise<string> {
  const ls = checkLeaves(leaves);
  return toHex(await subtreeHash(ls, 0, ls.length));
}

/** The audit path proving that leaf `index` is in the batch, nearest sibling first (RFC 9162 §2.1.3.1). */
export async function merkleAuditPath(leaves: readonly string[], index: number): Promise<string[]> {
  const ls = checkLeaves(leaves);
  if (!Number.isInteger(index) || index < 0 || index >= ls.length) throw new RangeError("leaf index out of range");
  const path: Uint8Array[] = [];
  const walk = async (m: number, lo: number, hi: number): Promise<void> => {
    if (hi - lo === 1) return;
    const k = split(hi - lo);
    if (m < k) {
      await walk(m, lo, lo + k);
      path.push(await subtreeHash(ls, lo + k, hi));
    } else {
      await walk(m - k, lo + k, hi);
      path.push(await subtreeHash(ls, lo, lo + k));
    }
  };
  await walk(index, 0, ls.length);
  return path.map(toHex);
}

export interface InclusionProof {
  /** Leaf hash (from `merkleLeaf`). */
  leaf: string;
  index: number;
  /** Number of leaves in the batch. */
  size: number;
  path: readonly string[];
  root: string;
}

/**
 * Whether `leaf` is at `index` in a batch of `size` leaves with this `root` (RFC 9162 §2.1.3.2).
 * Malformed input is simply not a proof: the answer is false, never an exception.
 */
export async function verifyMerkleInclusion(p: InclusionProof): Promise<boolean> {
  if (!isSha256Hex(p.leaf) || !isSha256Hex(p.root) || !p.path.every(isSha256Hex)) return false;
  if (!Number.isInteger(p.index) || !Number.isInteger(p.size) || p.index < 0 || p.index >= p.size || p.size > MAX_BATCH_LEAVES) return false;
  let fn = p.index;
  let sn = p.size - 1;
  let r = fromHex(p.leaf);
  for (const hex of p.path) {
    if (sn === 0) return false;
    const sibling = fromHex(hex);
    if (fn % 2 === 1 || fn === sn) {
      r = await node(sibling, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = await node(r, sibling);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && toHex(r) === p.root;
}

/**
 * Where an item's bytes are kept, and whether that place is content-addressed (so the bytes cannot
 * change without the reference changing):
 * - `sha256:<hex>`: the hash itself, bytes held elsewhere;
 * - `s3://<bucket>/<key>`: object storage, content-addressed only when the key's last segment is the
 *   item's SHA-256 (an optional extension may follow);
 * - `ipfs://<cid>` and `ar://<id>`: content-addressed by their own network.
 */
export type StorageRefKind = "hash" | "object_storage" | "ipfs" | "arweave";

export function checkStorageRef(ref: string, contentSha256: string): { kind: StorageRefKind } | { error: string } {
  if (ref.length > 512) return { error: "storage reference is too long" };
  if (ref.startsWith("sha256:")) return ref === `sha256:${contentSha256}` ? { kind: "hash" } : { error: "sha256: reference does not match the content hash" };
  if (/^ipfs:\/\/[A-Za-z0-9]{46,100}$/.test(ref)) return { kind: "ipfs" };
  if (/^ar:\/\/[A-Za-z0-9_-]{43}$/.test(ref)) return { kind: "arweave" };
  const s3 = /^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/(?:[A-Za-z0-9._-]+\/)*([0-9a-f]{64})(?:\.[a-z0-9]{1,10})?$/.exec(ref);
  if (s3) return s3[1] === contentSha256 ? { kind: "object_storage" } : { error: "the object key must end with the content hash" };
  return { error: "storage reference must be sha256:, s3:// (content-addressed key), ipfs:// or ar://" };
}
