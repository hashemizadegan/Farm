/**
 * Metaplex Bubblegum (V1) on SPL Account Compression: compressed NFTs for high-cardinality assets
 * (trees, parcels, animals). Instruction layouts, program-derived addresses, the tree config
 * account, leaf hashing and the leaf event follow the program's Anchor/Borsh encodings and are
 * checked byte for byte against @metaplex-foundation/mpl-bubblegum in the tests.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes, u16le, u32le, u64le, utf8 } from "../bytes";
import { base58Encode } from "./base58";
import type { Instruction } from "./codec";
import { ACCOUNT_COMPRESSION_PROGRAM } from "./compression";
import { SYSTEM_PROGRAM, addressBytes, findProgramAddress } from "./keys";

export const BUBBLEGUM_PROGRAM = "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";
export const SPL_NOOP_PROGRAM = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";

/** Token Metadata limits Bubblegum enforces (bytes, not characters). */
export const BUBBLEGUM_LIMITS = { name: 32, symbol: 10, uri: 200, creators: 5 } as const;

const DISCRIMINATOR = {
  createTreeConfig: Uint8Array.of(165, 83, 136, 142, 89, 202, 47, 220),
  mintV1: Uint8Array.of(145, 98, 192, 118, 184, 147, 118, 104),
  treeConfigAccount: Uint8Array.of(122, 245, 175, 248, 171, 34, 0, 207),
};

export interface CompressedCreator {
  address: string;
  /** Only a signer of the mint (payer or tree delegate) may be marked verified. */
  verified: boolean;
  share: number;
}

/** The metadata a leaf commits to. No collection and no uses: grouping is kept off chain for now. */
export interface CompressedMetadata {
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  primarySaleHappened: boolean;
  isMutable: boolean;
  creators: CompressedCreator[];
}

// ── Addresses ───────────────────────────────────────────────────────────

/** The tree's config (authority) account: seeds [merkle tree]. */
export const treeConfigAddress = (merkleTree: string) => findProgramAddress([addressBytes(merkleTree)], BUBBLEGUM_PROGRAM)[0];

/** The asset id of the leaf at `leafIndex`: seeds ["asset", merkle tree, leaf index (u64 LE)]. */
export const leafAssetId = (merkleTree: string, leafIndex: bigint) =>
  findProgramAddress([utf8("asset"), addressBytes(merkleTree), u64le(leafIndex)], BUBBLEGUM_PROGRAM)[0];

// ── Borsh ───────────────────────────────────────────────────────────────

const borshString = (s: string) => {
  const b = utf8(s);
  return concatBytes(u32le(b.length), b);
};
const bool = (v: boolean) => Uint8Array.of(v ? 1 : 0);
const NONE = Uint8Array.of(0);
const some = (b: Uint8Array) => concatBytes(Uint8Array.of(1), b);
const TOKEN_STANDARD_NON_FUNGIBLE = 0;
const TOKEN_PROGRAM_VERSION_ORIGINAL = 0;

export function checkMetadata(m: CompressedMetadata): void {
  if (utf8(m.name).length > BUBBLEGUM_LIMITS.name) throw new RangeError(`name is longer than ${BUBBLEGUM_LIMITS.name} bytes`);
  if (utf8(m.symbol).length > BUBBLEGUM_LIMITS.symbol) throw new RangeError(`symbol is longer than ${BUBBLEGUM_LIMITS.symbol} bytes`);
  if (utf8(m.uri).length > BUBBLEGUM_LIMITS.uri) throw new RangeError(`uri is longer than ${BUBBLEGUM_LIMITS.uri} bytes`);
  if (!Number.isInteger(m.sellerFeeBasisPoints) || m.sellerFeeBasisPoints < 0 || m.sellerFeeBasisPoints > 10_000) throw new RangeError("seller fee must be 0–10 000 basis points");
  if (m.creators.length > BUBBLEGUM_LIMITS.creators) throw new RangeError(`at most ${BUBBLEGUM_LIMITS.creators} creators`);
  if (m.creators.length > 0 && m.creators.reduce((s, c) => s + c.share, 0) !== 100) throw new RangeError("creator shares must add up to 100");
  if (m.creators.some((c) => !Number.isInteger(c.share) || c.share < 0 || c.share > 100)) throw new RangeError("creator share out of range");
  if (new Set(m.creators.map((c) => c.address)).size !== m.creators.length) throw new RangeError("duplicate creator");
}

const creatorBytes = (c: CompressedCreator) => concatBytes(addressBytes(c.address), bool(c.verified), Uint8Array.of(c.share));

/** Borsh MetadataArgs: a non-fungible, Original token program version, without collection or uses. */
export function encodeMetadataArgs(m: CompressedMetadata): Uint8Array {
  checkMetadata(m);
  return concatBytes(
    borshString(m.name),
    borshString(m.symbol),
    borshString(m.uri),
    u16le(m.sellerFeeBasisPoints),
    bool(m.primarySaleHappened),
    bool(m.isMutable),
    NONE, // edition nonce
    some(Uint8Array.of(TOKEN_STANDARD_NON_FUNGIBLE)),
    NONE, // collection
    NONE, // uses
    Uint8Array.of(TOKEN_PROGRAM_VERSION_ORIGINAL),
    u32le(m.creators.length),
    ...m.creators.map(creatorBytes),
  );
}

// ── Instructions ────────────────────────────────────────────────────────

/**
 * Initialises the tree config and the (already allocated, zeroed) Merkle tree account. A private
 * tree: only the creator or its delegate can mint into it.
 */
export function createTreeConfig(p: { merkleTree: string; payer: string; treeCreator: string; maxDepth: number; maxBufferSize: number; public?: boolean }): Instruction {
  return {
    programId: BUBBLEGUM_PROGRAM,
    accounts: [
      { address: treeConfigAddress(p.merkleTree), signer: false, writable: true },
      { address: p.merkleTree, signer: false, writable: true },
      { address: p.payer, signer: true, writable: true },
      { address: p.treeCreator, signer: true, writable: false },
      { address: SPL_NOOP_PROGRAM, signer: false, writable: false },
      { address: ACCOUNT_COMPRESSION_PROGRAM, signer: false, writable: false },
      { address: SYSTEM_PROGRAM, signer: false, writable: false },
    ],
    data: concatBytes(DISCRIMINATOR.createTreeConfig, u32le(p.maxDepth), u32le(p.maxBufferSize), p.public === undefined ? NONE : some(bool(p.public))),
  };
}

/** Appends one leaf owned by `leafOwner` (its own delegate unless one is given). */
export function mintV1(p: { merkleTree: string; leafOwner: string; leafDelegate?: string; payer: string; treeDelegate: string; metadata: CompressedMetadata }): Instruction {
  return {
    programId: BUBBLEGUM_PROGRAM,
    accounts: [
      { address: treeConfigAddress(p.merkleTree), signer: false, writable: true },
      { address: p.leafOwner, signer: false, writable: false },
      { address: p.leafDelegate ?? p.leafOwner, signer: false, writable: false },
      { address: p.merkleTree, signer: false, writable: true },
      { address: p.payer, signer: true, writable: false },
      { address: p.treeDelegate, signer: true, writable: false },
      { address: SPL_NOOP_PROGRAM, signer: false, writable: false },
      { address: ACCOUNT_COMPRESSION_PROGRAM, signer: false, writable: false },
      { address: SYSTEM_PROGRAM, signer: false, writable: false },
    ],
    data: concatBytes(DISCRIMINATOR.mintV1, encodeMetadataArgs(p.metadata)),
  };
}

// ── Accounts and events ─────────────────────────────────────────────────

export interface TreeConfig {
  treeCreator: string;
  treeDelegate: string;
  totalMintCapacity: bigint;
  /** Leaves minted so far: the next mint's leaf index. */
  numMinted: bigint;
  isPublic: boolean;
}

export function parseTreeConfig(data: Uint8Array): TreeConfig {
  if (data.length < 8 + 32 + 32 + 8 + 8 + 1 || !DISCRIMINATOR.treeConfigAccount.every((b, i) => data[i] === b)) throw new Error("not a Bubblegum tree config account");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    treeCreator: base58Encode(data.subarray(8, 40)),
    treeDelegate: base58Encode(data.subarray(40, 72)),
    totalMintCapacity: view.getBigUint64(72, true),
    numMinted: view.getBigUint64(80, true),
    isPublic: data[88] === 1,
  };
}

/** data_hash = keccak(keccak(MetadataArgs) ‖ seller fee u16); creator_hash = keccak(address ‖ verified ‖ share …). */
export function metadataHashes(m: CompressedMetadata): { dataHash: Uint8Array; creatorHash: Uint8Array } {
  return {
    dataHash: keccak_256(concatBytes(keccak_256(encodeMetadataArgs(m)), u16le(m.sellerFeeBasisPoints))),
    creatorHash: keccak_256(concatBytes(...m.creators.map(creatorBytes))),
  };
}

/** The V1 leaf node the tree stores for this asset. */
export function hashLeafV1(p: { merkleTree: string; leafIndex: bigint; owner: string; delegate?: string; metadata: CompressedMetadata }): string {
  const { dataHash, creatorHash } = metadataHashes(p.metadata);
  return base58Encode(
    keccak_256(
      concatBytes(
        Uint8Array.of(1),
        addressBytes(leafAssetId(p.merkleTree, p.leafIndex)),
        addressBytes(p.owner),
        addressBytes(p.delegate ?? p.owner),
        u64le(p.leafIndex),
        dataHash,
        creatorHash,
      ),
    ),
  );
}

export interface LeafEvent {
  assetId: string;
  owner: string;
  delegate: string;
  nonce: bigint;
  dataHash: string;
  creatorHash: string;
  leafHash: string;
}

/**
 * The leaf a mint appended, from the data of its noop inner instruction:
 * ApplicationData(V1(bytes)) wrapping LeafSchemaEvent { event type, version, LeafSchema::V1, leaf hash }.
 */
export function parseLeafEvent(data: Uint8Array): LeafEvent {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 6 || data[0] !== 1 || data[1] !== 0) throw new Error("not an application data event");
  const length = view.getUint32(2, true);
  const body = data.subarray(6, 6 + length);
  if (body.length !== length || length < 3 + 32 * 3 + 8 + 32 * 3) throw new Error("truncated leaf event");
  if (body[0] !== 1 || body[1] !== 0 || body[2] !== 0) throw new Error("not a V1 leaf schema event");
  const at = (i: number) => base58Encode(body.subarray(i, i + 32));
  const nonce = new DataView(body.buffer, body.byteOffset, body.byteLength).getBigUint64(3 + 96, true);
  return { assetId: at(3), owner: at(35), delegate: at(67), nonce, dataHash: at(107), creatorHash: at(139), leafHash: at(171) };
}
