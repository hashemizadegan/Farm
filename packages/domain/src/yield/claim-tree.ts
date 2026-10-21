/**
 * Claim tree (Real Yield Distribution plan, revision 4, §6.2): canonical leaves for a distribution plan's
 * payable entries, the Merkle root, inclusion proofs and a verifier. Pure: no I/O, no signing, no chain.
 *
 * **The hash function is D-26, which is open.** Hashing is a pluggable `ClaimTreeHasher`. The default,
 * `SHA256_RFC9162_HASHER`, is the construction the plan proposes: `leaf = SHA-256(0x00 ‖ SHA-256(leaf_bytes))`,
 * interior nodes `SHA-256(0x01 ‖ left ‖ right)`, RFC 9162 tree shape (any number of leaves). A tree is
 * built under a `ClaimTreePolicy` record naming the hasher; a real cycle needs an `approved` record, and
 * none exists until D-26 is approved, so real cycles fail closed. The simulation record uses the default.
 *
 * Leaf layout (`leaf_bytes`, 201 bytes, integers little-endian, plan §6.2):
 * domain tag 32 = SHA-256("metafarm-yield-leaf/1") ‖ network id 1 ‖ cluster identity 32 ‖ cycle id 16
 * (UUID bytes in RFC 4122 order) ‖ cycle version u32 ‖ epoch u32 ‖ economic asset id 32 ‖ recipient 32
 * ‖ payout mint 32 ‖ amount u64 ‖ formula version u16 ‖ leaf-layout version u16 ‖ leaf index u32.
 *
 * Every leaf field is an explicit input; nothing is defaulted. The cluster identity comes from Y0, which is
 * not built; callers supply it. Only `payable` entries get a leaf: deferred, withheld and unattributed
 * amounts have none. Leaves are ordered by recipient bytes, one leaf per payout wallet.
 */
import { YieldAmountError, U64_MAX, assertExactKeys } from "./amounts";
import type { DistributionPlan } from "./distribution";
import { YIELD_RECORD_STATUSES, assertYieldRecordUsable, type YieldRecordStatus } from "./records";

export const CLAIM_LEAF_DOMAIN = "metafarm-yield-leaf/1";
export const CLAIM_LEAF_LAYOUT_VERSION = 1;
export const CLAIM_LEAF_BYTES = 201;
/**
 * Leaf layout 2 binds every leaf to the cycle's ownership snapshot: the 201 bytes of layout 1 unchanged
 * (with layout version 2 at offset 195), followed by the 32-byte ownership snapshot hash. 233 bytes.
 * Layout 1 stays valid; which layout a tree uses is its policy's choice. The plan's §6.2 table defines
 * layout 1 only; layout 2 is an addition pending owner acknowledgement.
 */
export const CLAIM_LEAF_LAYOUT_VERSION_SNAPSHOT_BOUND = 2;
export const CLAIM_LEAF_BYTES_V2 = 233;
export const CLAIM_LEAF_LAYOUT_VERSIONS = [CLAIM_LEAF_LAYOUT_VERSION, CLAIM_LEAF_LAYOUT_VERSION_SNAPSHOT_BOUND] as const;
const leafLength = (layout: number) => (layout === CLAIM_LEAF_LAYOUT_VERSION_SNAPSHOT_BOUND ? CLAIM_LEAF_BYTES_V2 : CLAIM_LEAF_BYTES);
export const CLAIM_TREE_SCHEME = "metafarm-yield-claim-tree/1";

// ── Pluggable hashing (D-26) ──────────────────────────────────────────────────────────────────────

export interface ClaimTreeHasher {
  /** Identifies the construction; a policy names it. */
  readonly id: string;
  /** The leaf hash of the leaf bytes. 32 bytes. */
  leaf(leafBytes: Uint8Array): Promise<Uint8Array>;
  /** An interior node from its two children. 32 bytes. */
  node(left: Uint8Array, right: Uint8Array): Promise<Uint8Array>;
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", buf));
}

/** The plan's proposed construction (§6.2). The simulation default; pending D-26. */
export const SHA256_RFC9162_HASHER: ClaimTreeHasher = Object.freeze({
  id: "sha256-rfc9162-double-leaf/1",
  leaf: async (leafBytes: Uint8Array) => sha256(Uint8Array.of(0), await sha256(leafBytes)),
  node: (left: Uint8Array, right: Uint8Array) => sha256(Uint8Array.of(1), left, right),
});

// ── Policy (D-26) ────────────────────────────────────────────────────────────────────────────────

export interface ClaimTreePolicy {
  id: string;
  version: number;
  status: YieldRecordStatus;
  /** The hasher a tree under this policy must use. Pending D-26. */
  hasherId: string;
  /** Leaf layout: 1 (plan §6.2), or 2 (bound to the ownership snapshot). */
  leafLayoutVersion: 1 | 2;
  /** Largest number of leaves in one tree (≤ 2^32). */
  maxLeaves: number;
}

/** Temporary defaults for **simulation cycles only**; a real cycle refuses this record (pending D-26). */
export const SIMULATION_CLAIM_TREE_POLICY: ClaimTreePolicy = Object.freeze({
  id: "simulation-claim-tree",
  version: 1,
  status: "simulation",
  hasherId: SHA256_RFC9162_HASHER.id, // pending D-26
  leafLayoutVersion: 1,
  maxLeaves: 65_536, // pending: an operational bound for simulation
});

/** As SIMULATION_CLAIM_TREE_POLICY, with leaves bound to the ownership snapshot (layout 2). Simulation only. */
export const SIMULATION_CLAIM_TREE_POLICY_SNAPSHOT_BOUND: ClaimTreePolicy = Object.freeze({ ...SIMULATION_CLAIM_TREE_POLICY, id: "simulation-claim-tree-snapshot-bound", leafLayoutVersion: 2 });

export function claimTreePolicyProblems(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["a claim-tree policy must be an object"];
  const o = v as Record<string, unknown>;
  const out: string[] = [];
  const extra = Object.keys(o).filter((k) => !["id", "version", "status", "hasherId", "leafLayoutVersion", "maxLeaves"].includes(k));
  if (extra.length) out.push(`claim-tree policy has unsupported keys: ${extra.sort().join(", ")}`);
  if (typeof o.id !== "string" || o.id === "") out.push("id must be a non-empty string");
  if (!(typeof o.version === "number" && Number.isSafeInteger(o.version) && o.version >= 1)) out.push("version must be an integer ≥ 1");
  if (!(YIELD_RECORD_STATUSES as readonly unknown[]).includes(o.status)) out.push(`status must be one of ${YIELD_RECORD_STATUSES.join(", ")}`);
  if (typeof o.hasherId !== "string" || o.hasherId === "") out.push("hasherId must be a non-empty string");
  if (!(CLAIM_LEAF_LAYOUT_VERSIONS as readonly unknown[]).includes(o.leafLayoutVersion)) out.push(`leafLayoutVersion must be one of ${CLAIM_LEAF_LAYOUT_VERSIONS.join(", ")}`);
  if (!(typeof o.maxLeaves === "number" && Number.isSafeInteger(o.maxLeaves) && o.maxLeaves >= 1 && o.maxLeaves <= 2 ** 32)) out.push("maxLeaves must be an integer between 1 and 2^32");
  return out;
}

// ── Keys, ids and the leaf encoding ──────────────────────────────────────────────────────────────

export class ClaimTreeError extends Error {
  constructor(
    readonly code: "invalid_input" | "invalid_key" | "duplicate_recipient" | "empty_tree" | "too_many_leaves" | "hasher_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ClaimTreeError";
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * 32 bytes from a Solana address (base58) or 64 lowercase hex characters. Anything that does not decode to
 * exactly 32 bytes is refused.
 */
export function decodeKey32(name: string, v: unknown): Uint8Array {
  if (typeof v !== "string" || v === "") throw new ClaimTreeError("invalid_key", `${name} must be a base58 address or 64 lowercase hex characters`);
  if (HEX64.test(v)) return Uint8Array.from(v.match(/../g)!.map((x) => parseInt(x, 16)));
  let n = 0n;
  for (const c of v) {
    const d = B58.indexOf(c);
    if (d < 0) throw new ClaimTreeError("invalid_key", `${name} is not base58`);
    n = n * 58n + BigInt(d);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of v) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  if (bytes.length !== 32) throw new ClaimTreeError("invalid_key", `${name} decodes to ${bytes.length} bytes, not 32`);
  return Uint8Array.from(bytes);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The 16 bytes of a lowercase UUID, in RFC 4122 (written) order. */
export function uuidBytes(v: unknown): Uint8Array {
  if (typeof v !== "string" || !UUID.test(v)) throw new ClaimTreeError("invalid_input", "the cycle id must be a lowercase UUID");
  return Uint8Array.from(v.replace(/-/g, "").match(/../g)!.map((x) => parseInt(x, 16)));
}

export interface ClaimLeafContext {
  /** u8 network registry constant. */
  networkId: number;
  /** 32 bytes: the cluster's genesis hash recorded by Y0 (not built; supplied by the caller). */
  clusterIdentity: string;
  /** u32 (0 when unused). */
  epoch: number;
  /** 32 bytes: the Token-2022 mint or compressed-NFT asset id. */
  economicAssetId: string;
  /** 32 bytes: the settlement token's mint. */
  payoutMint: string;
  /** u16 version of the yield formula. */
  formulaVersion: number;
  /** 64 lowercase hex: the ownership snapshot hash. Required for layout 2, refused for layout 1. */
  ownershipSnapshotHash?: string;
}

export interface ClaimLeafFields {
  networkId: number;
  clusterIdentity: Uint8Array;
  cycleId: Uint8Array;
  cycleVersion: number;
  epoch: number;
  economicAssetId: Uint8Array;
  recipient: Uint8Array;
  payoutMint: Uint8Array;
  amount: bigint;
  formulaVersion: number;
  leafLayoutVersion: number;
  leafIndex: number;
  /** Layout 2 only: the 32-byte ownership snapshot hash. Absent for layout 1. */
  ownershipSnapshotHash?: Uint8Array;
}

const uint = (name: string, v: unknown, bits: 8 | 16 | 32) => {
  if (!(typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < 2 ** bits)) throw new ClaimTreeError("invalid_input", `${name} must be a u${bits}`);
  return v;
};

let domainTag: Promise<Uint8Array> | null = null;
/** SHA-256("metafarm-yield-leaf/1"). */
export function claimLeafDomainTag(): Promise<Uint8Array> {
  domainTag ??= sha256(new TextEncoder().encode(CLAIM_LEAF_DOMAIN));
  return domainTag;
}

/**
 * The leaf bytes: 201 for layout 1, 233 for layout 2. Refuses an amount that is not 0 < amount ≤ u64 with
 * `amount_out_of_range`.
 */
export async function encodeClaimLeaf(f: ClaimLeafFields): Promise<Uint8Array> {
  if (typeof f.amount !== "bigint" || f.amount <= 0n || f.amount > U64_MAX) throw new YieldAmountError("amount_out_of_range", "a leaf amount must satisfy 0 < amount ≤ 2^64 − 1");
  if (!(CLAIM_LEAF_LAYOUT_VERSIONS as readonly unknown[]).includes(f.leafLayoutVersion)) throw new ClaimTreeError("invalid_input", `unknown leaf layout ${String(f.leafLayoutVersion)}`);
  const bound = f.leafLayoutVersion === CLAIM_LEAF_LAYOUT_VERSION_SNAPSHOT_BOUND;
  if (bound && !(f.ownershipSnapshotHash instanceof Uint8Array && f.ownershipSnapshotHash.length === 32)) throw new ClaimTreeError("invalid_input", "a layout 2 leaf needs the 32-byte ownership snapshot hash");
  if (!bound && f.ownershipSnapshotHash !== undefined) throw new ClaimTreeError("invalid_input", "a layout 1 leaf has no ownership snapshot hash");
  for (const [k, len] of [["clusterIdentity", 32], ["cycleId", 16], ["economicAssetId", 32], ["recipient", 32], ["payoutMint", 32]] as const)
    if (!(f[k] instanceof Uint8Array) || f[k].length !== len) throw new ClaimTreeError("invalid_input", `${k} must be ${len} bytes`);
  const out = new Uint8Array(leafLength(f.leafLayoutVersion));
  const view = new DataView(out.buffer);
  let at = 0;
  const put = (b: Uint8Array) => {
    out.set(b, at);
    at += b.length;
  };
  put(await claimLeafDomainTag());
  view.setUint8(at, uint("networkId", f.networkId, 8));
  at += 1;
  put(f.clusterIdentity);
  put(f.cycleId);
  view.setUint32(at, uint("cycleVersion", f.cycleVersion, 32), true);
  at += 4;
  view.setUint32(at, uint("epoch", f.epoch, 32), true);
  at += 4;
  put(f.economicAssetId);
  put(f.recipient);
  put(f.payoutMint);
  view.setBigUint64(at, f.amount, true);
  at += 8;
  view.setUint16(at, uint("formulaVersion", f.formulaVersion, 16), true);
  at += 2;
  view.setUint16(at, uint("leafLayoutVersion", f.leafLayoutVersion, 16), true);
  at += 2;
  view.setUint32(at, uint("leafIndex", f.leafIndex, 32), true);
  at += 4;
  if (bound) put(f.ownershipSnapshotHash!);
  if (at !== out.length) throw new ClaimTreeError("invalid_input", "internal: leaf length");
  return out;
}

/** Decodes leaf bytes (layout 1: 201 bytes; layout 2: 233), checking the domain tag, layout and length. */
export async function decodeClaimLeaf(bytes: Uint8Array): Promise<ClaimLeafFields> {
  if (!(bytes instanceof Uint8Array) || (bytes.length !== CLAIM_LEAF_BYTES && bytes.length !== CLAIM_LEAF_BYTES_V2)) throw new ClaimTreeError("invalid_input", `a leaf is ${CLAIM_LEAF_BYTES} or ${CLAIM_LEAF_BYTES_V2} bytes`);
  const tag = await claimLeafDomainTag();
  if (!tag.every((b, i) => b === bytes[i])) throw new ClaimTreeError("invalid_input", "the leaf's domain tag is not metafarm-yield-leaf/1");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const slice = (from: number, len: number) => bytes.slice(from, from + len);
  const f: ClaimLeafFields = {
    networkId: view.getUint8(32),
    clusterIdentity: slice(33, 32),
    cycleId: slice(65, 16),
    cycleVersion: view.getUint32(81, true),
    epoch: view.getUint32(85, true),
    economicAssetId: slice(89, 32),
    recipient: slice(121, 32),
    payoutMint: slice(153, 32),
    amount: view.getBigUint64(185, true),
    formulaVersion: view.getUint16(193, true),
    leafLayoutVersion: view.getUint16(195, true),
    leafIndex: view.getUint32(197, true),
  };
  if (!(CLAIM_LEAF_LAYOUT_VERSIONS as readonly number[]).includes(f.leafLayoutVersion)) throw new ClaimTreeError("invalid_input", `unknown leaf layout ${f.leafLayoutVersion}`);
  if (bytes.length !== leafLength(f.leafLayoutVersion)) throw new ClaimTreeError("invalid_input", `a layout ${f.leafLayoutVersion} leaf is ${leafLength(f.leafLayoutVersion)} bytes`);
  if (f.leafLayoutVersion === CLAIM_LEAF_LAYOUT_VERSION_SNAPSHOT_BOUND) f.ownershipSnapshotHash = slice(201, 32);
  // A zero-amount claim is never valid (zero-allocation policy): refused on decode as on encode.
  if (f.amount === 0n) throw new ClaimTreeError("invalid_input", "a leaf amount must be greater than zero");
  return f;
}

// ── RFC 9162 tree over any hasher ────────────────────────────────────────────────────────────────

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

/**
 * All levels of the RFC 9162 tree over already-hashed leaves, bottom-up. Pairing left to right and
 * carrying an unpaired last node up unchanged gives the same root and audit paths as RFC 9162's recursive
 * definition (largest power of two below n on the left).
 */
async function levels(hasher: ClaimTreeHasher, leafHashes: Uint8Array[]): Promise<Uint8Array[][]> {
  const out = [leafHashes];
  while (out[out.length - 1]!.length > 1) {
    const cur = out[out.length - 1]!;
    const next: Uint8Array[] = [];
    for (let i = 0; i + 1 < cur.length; i += 2) next.push(await hasher.node(cur[i]!, cur[i + 1]!));
    if (cur.length % 2 === 1) next.push(cur[cur.length - 1]!);
    out.push(next);
  }
  return out;
}

function auditPath(lv: Uint8Array[][], index: number): Uint8Array[] {
  const path: Uint8Array[] = [];
  let i = index;
  for (let l = 0; l < lv.length - 1; l++) {
    const level = lv[l]!;
    const sibling = i ^ 1;
    if (sibling < level.length) path.push(level[sibling]!);
    i = Math.floor(i / 2);
  }
  return path;
}

export interface ClaimProof {
  leafIndex: number;
  treeSize: number;
  /** Hex. */
  leafHash: string;
  /** Hex sibling hashes, nearest first. */
  path: string[];
  /** Hex. */
  root: string;
}

/**
 * Whether `leafBytes` is at `proof.leafIndex` in the tree with `proof.root` (RFC 9162 §2.1.3.2), under
 * `hasher`. The leaf hash is recomputed from the bytes. Malformed input is not a proof: false, never an
 * exception. The root and size are taken from the proof; to check a claim leaf against a published tree,
 * use `verifyClaimLeafProof`.
 */
export async function verifyClaimProof(hasher: ClaimTreeHasher, leafBytes: Uint8Array, proof: ClaimProof): Promise<boolean> {
  try {
    const isHash = (s: unknown) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
    if (!(leafBytes instanceof Uint8Array) || !isHash(proof.leafHash) || !isHash(proof.root) || !Array.isArray(proof.path) || !proof.path.every(isHash)) return false;
    const { leafIndex, treeSize } = proof;
    if (!Number.isSafeInteger(leafIndex) || !Number.isSafeInteger(treeSize) || leafIndex < 0 || leafIndex >= treeSize || treeSize > 2 ** 32) return false;
    const leaf = await hasher.leaf(leafBytes);
    if (hex(leaf) !== proof.leafHash) return false;
    let fn = leafIndex;
    let sn = treeSize - 1;
    let r = leaf;
    for (const h of proof.path) {
      if (sn === 0) return false;
      const sibling = unhex(h);
      if (fn % 2 === 1 || fn === sn) {
        r = await hasher.node(sibling, r);
        if (fn % 2 === 0) {
          while (fn % 2 === 0 && fn !== 0) {
            fn = Math.floor(fn / 2);
            sn = Math.floor(sn / 2);
          }
        }
      } else {
        r = await hasher.node(r, sibling);
      }
      fn = Math.floor(fn / 2);
      sn = Math.floor(sn / 2);
    }
    return sn === 0 && hex(r) === proof.root;
  } catch {
    return false;
  }
}

/**
 * Verifies a claim leaf against a **trusted** root and tree size (taken from the published tree, never from
 * the proof). An RFC 9162 inclusion proof does not bind the tree size by itself: the same path can verify
 * under a different claimed size. This also decodes the leaf and requires the leaf index inside the leaf
 * bytes to equal the proof's index. Malformed input gives false.
 */
export async function verifyClaimLeafProof(hasher: ClaimTreeHasher, leafBytes: Uint8Array, proof: ClaimProof, trusted: { root: string; treeSize: number }): Promise<boolean> {
  if (!trusted || proof?.root !== trusted.root || proof.treeSize !== trusted.treeSize) return false;
  try {
    if ((await decodeClaimLeaf(leafBytes)).leafIndex !== proof.leafIndex) return false;
  } catch {
    return false;
  }
  return verifyClaimProof(hasher, leafBytes, proof);
}

/** Root and proofs for arbitrary leaf bytes under a hasher (used by the claim tree, and for cross-checks). */
export async function merkleTreeOverLeafBytes(hasher: ClaimTreeHasher, leafBytes: readonly Uint8Array[]): Promise<{ root: string; leafHashes: string[]; proofs: ClaimProof[] }> {
  if (leafBytes.length === 0) throw new ClaimTreeError("empty_tree", "a tree needs at least one leaf");
  const hashes = [];
  for (const b of leafBytes) hashes.push(await hasher.leaf(b));
  const lv = await levels(hasher, hashes);
  const root = hex(lv[lv.length - 1]![0]!);
  const leafHashes = hashes.map(hex);
  const proofs = leafHashes.map((leafHash, i) => ({ leafIndex: i, treeSize: hashes.length, leafHash, path: auditPath(lv, i).map(hex), root }));
  return { root, leafHashes, proofs };
}

// ── The claim tree of a distribution plan ─────────────────────────────────────────────────────────

export interface ClaimLeaf {
  leafIndex: number;
  partyId: string;
  /** The payout wallet as given in the plan. */
  payoutWallet: string;
  /** Hex of the 32 recipient bytes. */
  recipient: string;
  amount: bigint;
  /** Hex of the 201 leaf bytes. */
  leafBytes: string;
  leafHash: string;
  proof: ClaimProof;
}

export interface ClaimTree {
  scheme: typeof CLAIM_TREE_SCHEME;
  hasherId: string;
  policy: { id: string; version: number; status: YieldRecordStatus };
  cycle: { id: string; version: number; simulation: boolean };
  context: ClaimLeafContext;
  root: string;
  size: number;
  leaves: ClaimLeaf[];
}

/**
 * Builds the claim tree of a distribution plan's payable entries. The hasher must be the one the policy
 * names, and the policy must be usable for the plan's cycle (real cycles need an approved one: D-26).
 */
export async function buildClaimTree(input: { plan: DistributionPlan; policy: ClaimTreePolicy; hasher: ClaimTreeHasher; context: ClaimLeafContext }): Promise<ClaimTree> {
  assertExactKeys("claim tree input", input, ["plan", "policy", "hasher", "context"]);
  const { plan, policy, hasher, context } = input;
  const problems = claimTreePolicyProblems(policy);
  if (problems.length) throw new ClaimTreeError("invalid_input", `invalid claim-tree policy: ${problems.join("; ")}`);
  const cycle = plan?.cycle;
  if (!cycle || typeof cycle.simulation !== "boolean") throw new ClaimTreeError("invalid_input", "the plan has no cycle");
  assertYieldRecordUsable(cycle, { status: policy.status, kind: "claim-tree policy" });
  if (!hasher || hasher.id !== policy.hasherId) throw new ClaimTreeError("hasher_mismatch", `the policy requires hasher ${policy.hasherId}, not ${String(hasher?.id)}`);
  assertExactKeys("leaf context", context as unknown, ["networkId", "clusterIdentity", "epoch", "economicAssetId", "payoutMint", "formulaVersion", "ownershipSnapshotHash"]);
  const bound = policy.leafLayoutVersion === CLAIM_LEAF_LAYOUT_VERSION_SNAPSHOT_BOUND;
  if (bound && !(typeof context.ownershipSnapshotHash === "string" && /^[0-9a-f]{64}$/.test(context.ownershipSnapshotHash))) throw new ClaimTreeError("invalid_input", "a layout 2 tree needs the ownership snapshot hash (64 lowercase hex)");
  if (!bound && context.ownershipSnapshotHash !== undefined) throw new ClaimTreeError("invalid_input", "a layout 1 tree takes no ownership snapshot hash");

  const fixed = {
    networkId: uint("networkId", context.networkId, 8),
    clusterIdentity: decodeKey32("clusterIdentity", context.clusterIdentity),
    cycleId: uuidBytes(cycle.id),
    cycleVersion: uint("cycleVersion", cycle.version, 32),
    epoch: uint("epoch", context.epoch, 32),
    economicAssetId: decodeKey32("economicAssetId", context.economicAssetId),
    payoutMint: decodeKey32("payoutMint", context.payoutMint),
    formulaVersion: uint("formulaVersion", context.formulaVersion, 16),
    leafLayoutVersion: policy.leafLayoutVersion,
    ...(bound ? { ownershipSnapshotHash: unhex(context.ownershipSnapshotHash!) } : {}),
  };

  const payable = plan.entries.filter((e) => e.state === "payable");
  if (payable.length === 0) throw new ClaimTreeError("empty_tree", "the plan has no payable entries");
  if (payable.length > policy.maxLeaves) throw new ClaimTreeError("too_many_leaves", `${payable.length} leaves exceed the policy's ${policy.maxLeaves}`);
  const rows = payable.map((e) => {
    if (e.partyId === null || e.payoutWallet === null) throw new ClaimTreeError("invalid_input", "a payable entry needs a party and a payout wallet");
    return { partyId: e.partyId, payoutWallet: e.payoutWallet, recipient: decodeKey32(`payout wallet of ${e.partyId}`, e.payoutWallet), amount: e.amount };
  });
  rows.sort((a, b) => {
    for (let i = 0; i < 32; i++) if (a.recipient[i] !== b.recipient[i]) return a.recipient[i]! - b.recipient[i]!;
    return 0;
  });
  for (let i = 1; i < rows.length; i++)
    if (hex(rows[i]!.recipient) === hex(rows[i - 1]!.recipient)) throw new ClaimTreeError("duplicate_recipient", `parties ${rows[i - 1]!.partyId} and ${rows[i]!.partyId} share a payout wallet: one leaf per wallet`);

  const leafBytes: Uint8Array[] = [];
  for (const [i, r] of rows.entries()) leafBytes.push(await encodeClaimLeaf({ ...fixed, recipient: r.recipient, amount: r.amount, leafIndex: i }));
  const tree = await merkleTreeOverLeafBytes(hasher, leafBytes);
  return {
    scheme: CLAIM_TREE_SCHEME,
    hasherId: hasher.id,
    policy: { id: policy.id, version: policy.version, status: policy.status },
    cycle: { ...cycle },
    context: { ...context },
    root: tree.root,
    size: rows.length,
    leaves: rows.map((r, i) => ({
      leafIndex: i,
      partyId: r.partyId,
      payoutWallet: r.payoutWallet,
      recipient: hex(r.recipient),
      amount: r.amount,
      leafBytes: hex(leafBytes[i]!),
      leafHash: tree.leafHashes[i]!,
      proof: tree.proofs[i]!,
    })),
  };
}
