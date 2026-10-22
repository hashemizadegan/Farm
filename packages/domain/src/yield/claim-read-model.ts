/**
 * Claim read model (simulation only): an indexed projection of a verified cycle artifact, so a single holder's
 * claim can be served by reading a handful of records instead of hydrating the whole artifact.
 *
 * Write side: `projectClaimReadModel` verifies the artifact (as `createClaimLookup` does) and writes records
 * into a `ClaimReadModelSink`. Read side: `openClaimReadModel` reads only the header; each query reads only
 * the records it needs from a `ClaimReadModelStore`:
 *
 *   header                        1 read, once, at open
 *   claim by party id             2 + path-length reads: holder record, leaf record, one node per path entry
 *   claim by payout address       1 more read (the recipient index record)
 *   withheld / deferred           1 read
 *   unattributed / not in cycle   2 reads
 *
 * Proofs are not stored per leaf: the tree's nodes are stored once by (level, index), and a proof is rebuilt
 * from ⌈log2 L⌉ of them. Every claim served is first verified against the header's published tree (leaf
 * decoding, layout 2 snapshot binding, proof), so a damaged or tampered store fails closed (`corrupt`) rather
 * than serving an unverified claim. Results are exactly those of `createClaimLookup` for the same artifact.
 *
 * Trust: the published tree in the header is pinned by the artifact hash the caller expects. Holder and
 * recipient index records only say which leaf to read; the leaf itself binds the recipient and amount, so a
 * damaged index cannot redirect a payout. Images are pinned by their own SHA-256.
 *
 * Storage here is in memory (`InMemoryClaimReadModelStore`) with a deterministic byte image for round trips;
 * nothing reads or writes files, databases or the network. A durable store would implement the same two
 * interfaces. Simulation only: non-simulation artifacts, headers and real networks are refused.
 */
import { canonicalYieldArtifact } from "./artifact";
import { type ClaimTreeHasher, auditPathFromLevels, claimTreeLevels, decodeKey32 } from "./claim-tree";
import { CLAIM_PAYLOAD_SCHEME, type ClaimLookupResult, type ClaimPayloadDto, type PublishedClaimTree, verifyClaimPayload } from "./claim-lookup";
import type { DistributionDeferredReason } from "./distribution";
import { SIMULATION_NETWORK_IDS } from "./ownership-snapshot";
import { type CycleDistributionArtifact, cycleArtifactProblems } from "./pipeline";
import { contentHash } from "../twin/commitments";

export const CLAIM_READ_MODEL_SCHEME = "metafarm-yield-claim-read-model/1";
export const CLAIM_READ_MODEL_IMAGE_SCHEME = "metafarm-yield-claim-read-model-image/1";

/** Read side of a store: one value per key, or null. */
export interface ClaimReadModelStore {
  get(key: string): Promise<string | null>;
}

/** Write side of a store. Records are immutable: writing a key twice is refused. */
export interface ClaimReadModelSink {
  put(key: string, value: string): Promise<void>;
}

export type ClaimReadModelErrorCode = "simulation_only" | "real_network" | "artifact_invalid" | "not_found" | "header_mismatch" | "corrupt" | "invalid_image" | "image_hash_mismatch" | "duplicate_key";

export class ClaimReadModelError extends Error {
  constructor(
    readonly code: ClaimReadModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClaimReadModelError";
  }
}

const fail = (code: ClaimReadModelErrorCode, message: string): never => {
  throw new ClaimReadModelError(code, message);
};

// ── Records ──────────────────────────────────────────────────────────────────────────────────────

/** The cycle summary and published tree: everything needed to open the read model. */
export interface ClaimReadModelHeader {
  scheme: typeof CLAIM_READ_MODEL_SCHEME;
  cycleId: string;
  cycleVersion: number;
  simulation: true;
  networkId: string;
  artifactSha256: string;
  /** null when the cycle has no payable entry (no tree). */
  published: PublishedClaimTree | null;
  /** Size of each tree level, leaves first, root last (empty without a tree). */
  levelSizes: number[];
  summary: {
    evidenceManifestSha256: string;
    calculationSha256: string;
    planSha256: string;
    ownershipSnapshotHash: string;
    settlementAmount: string;
    totals: Record<"inflow" | "leaves" | "dustCarriedForward" | "withheld" | "unattributed" | "remainderCarried", string>;
    counts: { parties: number; unattributed: number; leaves: number };
  };
}

type HolderRecord = { status: "claim"; leafIndex: number } | { status: "no_leaf"; reason: "withheld" } | { status: "no_leaf"; reason: "deferred"; deferredReason: DistributionDeferredReason };
interface LeafRecord {
  partyId: string;
  recipient: string;
  amount: string;
  leafBytes: string;
  leafHash: string;
}

/** Record keys. One store can hold several cycles. */
export const readModelKeys = (cycleId: string, cycleVersion: number) => {
  const base = `c/${cycleId}/${cycleVersion}`;
  return {
    header: `${base}/h`,
    party: (partyId: string) => `${base}/p/${partyId}`,
    unattributed: (holderKey: string) => `${base}/u/${holderKey}`,
    recipient: (hex: string) => `${base}/r/${hex}`,
    leaf: (index: number) => `${base}/l/${index}`,
    node: (level: number, index: number) => `${base}/n/${level}/${index}`,
  };
};

const json = (v: unknown) => canonicalYieldArtifact(v);
const toHex = (address: string): string | null => {
  try {
    return [...decodeKey32("payout address", address)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
};

// ── Write side ───────────────────────────────────────────────────────────────────────────────────

/**
 * Verifies a simulation artifact and writes its read model. Returns the header. This is the only step that
 * holds the whole artifact; queries never need it again.
 */
export async function projectClaimReadModel(artifact: CycleDistributionArtifact, artifactSha256: string, hasher: ClaimTreeHasher, sink: ClaimReadModelSink): Promise<ClaimReadModelHeader> {
  if (artifact?.cycle?.simulation !== true) fail("simulation_only", "the read model serves simulation cycles only");
  if (!(SIMULATION_NETWORK_IDS as readonly unknown[]).includes(artifact.ownership?.networkId)) fail("real_network", `network ${String(artifact.ownership?.networkId)} is not a simulation network`);
  const problems = await cycleArtifactProblems(artifact, artifactSha256, hasher);
  if (problems.length) fail("artifact_invalid", `the artifact does not verify: ${problems.join("; ")}`);

  const { id: cycleId, version: cycleVersion } = artifact.cycle;
  const k = readModelKeys(cycleId, cycleVersion);
  const tree = artifact.claimTree;
  const plan = artifact.distribution.plan;

  let levelSizes: number[] = [];
  if (tree) {
    const levels = await claimTreeLevels(hasher, tree.leaves.map((l) => l.leafHash));
    if (levels[levels.length - 1]![0] !== tree.root) fail("artifact_invalid", "the recomputed root does not match the published root");
    levelSizes = levels.map((l) => l.length);
    for (const [level, nodes] of levels.entries()) for (const [i, node] of nodes.entries()) await sink.put(k.node(level, i), node);
    for (const l of tree.leaves) await sink.put(k.leaf(l.leafIndex), json({ partyId: l.partyId, recipient: l.recipient, amount: l.amount.toString(), leafBytes: l.leafBytes, leafHash: l.leafHash } satisfies LeafRecord));
  }

  const leafOf = new Map((tree?.leaves ?? []).map((l) => [l.partyId, l.leafIndex]));
  const parties = new Set<string>();
  for (const e of plan.entries) {
    if (e.kind === "unattributed") {
      await sink.put(k.unattributed(e.holderKey!), json({ status: "unattributed" }));
      continue;
    }
    const partyId = e.partyId!;
    parties.add(partyId);
    const record: HolderRecord =
      e.state === "payable"
        ? { status: "claim", leafIndex: leafOf.get(partyId)! }
        : e.state === "withheld"
          ? { status: "no_leaf", reason: "withheld" }
          : { status: "no_leaf", reason: "deferred", deferredReason: e.deferredReason ?? "below_dust_threshold" };
    await sink.put(k.party(partyId), json(record));
    const hex = e.payoutWallet === null ? null : toHex(e.payoutWallet);
    if (hex !== null) await sink.put(k.recipient(hex), json({ partyId }));
  }
  // Dust carried from earlier cycles for parties with no share this cycle.
  for (const d of plan.ledgerOut.deferred) {
    if (parties.has(d.partyId)) continue;
    await sink.put(k.party(d.partyId), json({ status: "no_leaf", reason: "deferred", deferredReason: "below_dust_threshold" } satisfies HolderRecord));
  }

  const t = artifact.totals;
  const header: ClaimReadModelHeader = {
    scheme: CLAIM_READ_MODEL_SCHEME,
    cycleId,
    cycleVersion,
    simulation: true,
    networkId: artifact.ownership.networkId,
    artifactSha256,
    published: tree ? { cycleId, cycleVersion, simulation: true, hasherId: tree.hasherId, root: tree.root, treeSize: tree.size, ownershipSnapshotHash: artifact.ownership.snapshotHash } : null,
    levelSizes,
    summary: {
      evidenceManifestSha256: artifact.evidence.manifestSha256,
      calculationSha256: artifact.calculation.artifactSha256,
      planSha256: artifact.distribution.planSha256,
      ownershipSnapshotHash: artifact.ownership.snapshotHash,
      settlementAmount: artifact.calculation.settlementAmount.toString(),
      totals: { inflow: t.inflow.toString(), leaves: t.leaves.toString(), dustCarriedForward: t.dustCarriedForward.toString(), withheld: t.withheld.toString(), unattributed: t.unattributed.toString(), remainderCarried: t.remainderCarried.toString() },
      counts: { parties: plan.entries.filter((e) => e.kind === "party").length, unattributed: plan.entries.filter((e) => e.kind === "unattributed").length, leaves: tree?.size ?? 0 },
    },
  };
  await sink.put(k.header, json(header));
  return header;
}

// ── Read side ────────────────────────────────────────────────────────────────────────────────────

export interface ClaimReadModel {
  readonly header: ClaimReadModelHeader;
  readonly published: PublishedClaimTree | null;
  byPartyId(partyId: string): Promise<ClaimLookupResult>;
  /** By payout address: a Solana base58 address or 64 lowercase hex characters. */
  byPayoutAddress(address: string): Promise<ClaimLookupResult>;
  /** The claim at a leaf index (for paging through claims without loading them all). */
  claimAt(leafIndex: number): Promise<ClaimPayloadDto>;
}

function parse(key: string, raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch (e) {
    return fail("corrupt", `record ${key} is not a JSON object: ${(e as Error).message}`);
  }
}

function checkHeader(h: Record<string, unknown>, expected: { cycleId: string; cycleVersion: number; artifactSha256: string }, hasher: ClaimTreeHasher): ClaimReadModelHeader {
  if (h.scheme !== CLAIM_READ_MODEL_SCHEME) fail("corrupt", "the header has another scheme");
  if (h.simulation !== true) fail("simulation_only", "the read model serves simulation cycles only");
  if (!(SIMULATION_NETWORK_IDS as readonly unknown[]).includes(h.networkId)) fail("real_network", `network ${String(h.networkId)} is not a simulation network`);
  if (h.cycleId !== expected.cycleId || h.cycleVersion !== expected.cycleVersion || h.artifactSha256 !== expected.artifactSha256) fail("header_mismatch", "the header is not for the expected cycle version and artifact");
  const p = h.published as PublishedClaimTree | null;
  const sizes = h.levelSizes as number[];
  if (!Array.isArray(sizes) || !sizes.every((n) => Number.isSafeInteger(n) && n >= 1)) fail("corrupt", "levelSizes must be positive integers");
  if (p === null) {
    if (sizes.length !== 0) fail("corrupt", "a header without a tree has no levels");
  } else {
    if (p?.simulation !== true || p.cycleId !== h.cycleId || p.cycleVersion !== h.cycleVersion) fail("corrupt", "the published tree does not match the header");
    if (p.hasherId !== hasher.id) fail("header_mismatch", `the tree was built with ${String(p.hasherId)}, not ${hasher.id}`);
    // Level sizes follow from the tree size: n, ⌈n/2⌉, …, 1.
    const want: number[] = [p.treeSize];
    while (want[want.length - 1]! > 1) want.push(Math.ceil(want[want.length - 1]! / 2));
    if (JSON.stringify(want) !== JSON.stringify(sizes)) fail("corrupt", "levelSizes do not match the tree size");
  }
  return h as unknown as ClaimReadModelHeader;
}

/**
 * Opens a cycle's read model, reading only its header. The caller states which artifact it expects (by hash),
 * so the published tree every claim is verified against is pinned.
 */
export async function openClaimReadModel(store: ClaimReadModelStore, expected: { cycleId: string; cycleVersion: number; artifactSha256: string }, hasher: ClaimTreeHasher): Promise<ClaimReadModel> {
  const k = readModelKeys(expected.cycleId, expected.cycleVersion);
  const raw = await store.get(k.header);
  if (raw === null) return fail("not_found", `no read model for cycle ${expected.cycleId} version ${expected.cycleVersion}`);
  const header = Object.freeze(checkHeader(parse(k.header, raw), expected, hasher));
  const published = header.published === null ? null : Object.freeze({ ...header.published });

  const node = async (level: number, index: number) => {
    const v = await store.get(k.node(level, index));
    if (v === null || !/^[0-9a-f]{64}$/.test(v)) return fail("corrupt", `node ${level}/${index} is missing or malformed`);
    return v;
  };

  const claimAt = async (leafIndex: number, partyId: string | null): Promise<ClaimPayloadDto> => {
    if (published === null || !Number.isSafeInteger(leafIndex) || leafIndex < 0 || leafIndex >= published.treeSize) return fail("corrupt", `leaf ${leafIndex} is outside the tree`);
    const key = k.leaf(leafIndex);
    const raw = await store.get(key);
    if (raw === null) return fail("corrupt", `leaf ${leafIndex} is missing`);
    const l = parse(key, raw) as unknown as LeafRecord;
    if (partyId !== null && l.partyId !== partyId) fail("corrupt", `leaf ${leafIndex} belongs to ${String(l.partyId)}, not ${partyId}`);
    const claim: ClaimPayloadDto = {
      scheme: CLAIM_PAYLOAD_SCHEME,
      cycleId: published.cycleId,
      cycleVersion: published.cycleVersion,
      simulation: true,
      hasherId: published.hasherId,
      root: published.root,
      treeSize: published.treeSize,
      ownershipSnapshotHash: published.ownershipSnapshotHash,
      leafIndex,
      partyId: l.partyId,
      recipient: l.recipient,
      amount: l.amount,
      leafBytes: l.leafBytes,
      leafHash: l.leafHash,
      path: await auditPathFromLevels(header.levelSizes, leafIndex, node),
    };
    // Fail closed: serve nothing that does not verify against the pinned published tree.
    if (!(await verifyClaimPayload(claim, published, hasher))) fail("corrupt", `leaf ${leafIndex} does not verify against the published tree`);
    Object.freeze(claim.path);
    return Object.freeze(claim);
  };

  const byPartyId = async (partyId: string): Promise<ClaimLookupResult> => {
    if (typeof partyId !== "string" || partyId === "") return { status: "not_in_cycle" };
    const key = k.party(partyId);
    const raw = await store.get(key);
    if (raw === null) return (await store.get(k.unattributed(partyId))) === null ? { status: "not_in_cycle" } : { status: "unattributed" };
    const r = parse(key, raw) as unknown as HolderRecord;
    if (r.status === "claim") return { status: "claim", claim: await claimAt(r.leafIndex, partyId) };
    if (r.status === "no_leaf" && r.reason === "withheld") return { status: "no_leaf", reason: "withheld" };
    if (r.status === "no_leaf" && r.reason === "deferred" && (r.deferredReason === "zero_amount" || r.deferredReason === "below_dust_threshold")) return { status: "no_leaf", reason: "deferred", deferredReason: r.deferredReason };
    return fail("corrupt", `holder record ${key} is malformed`);
  };

  return Object.freeze({
    header,
    published,
    byPartyId,
    async byPayoutAddress(address: string): Promise<ClaimLookupResult> {
      const hex = typeof address === "string" ? toHex(address) : null;
      if (hex === null) return { status: "not_in_cycle" };
      const key = k.recipient(hex);
      const raw = await store.get(key);
      if (raw === null) return { status: "not_in_cycle" };
      const partyId = parse(key, raw).partyId;
      if (typeof partyId !== "string") return fail("corrupt", `recipient record ${key} is malformed`);
      const result = await byPartyId(partyId);
      if (result.status === "claim" && result.claim.recipient !== hex) fail("corrupt", `the recipient index for ${hex} points at another recipient's claim`);
      return result;
    },
    claimAt: (leafIndex: number) => claimAt(leafIndex, null),
  });
}

// ── In-memory store and its byte image ───────────────────────────────────────────────────────────

/** A simulation store: immutable records in memory, with read accounting. */
export class InMemoryClaimReadModelStore implements ClaimReadModelStore, ClaimReadModelSink {
  readonly #records = new Map<string, string>();
  readonly stats = { gets: 0, bytesRead: 0 };

  async put(key: string, value: string): Promise<void> {
    if (typeof key !== "string" || key === "" || typeof value !== "string") fail("invalid_image", "keys and values are strings; keys are non-empty");
    if (this.#records.has(key)) fail("duplicate_key", `record ${key} already exists (records are immutable)`);
    this.#records.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    this.stats.gets++;
    const v = this.#records.get(key) ?? null;
    if (v !== null) this.stats.bytesRead += v.length;
    return v;
  }

  get size(): number {
    return this.#records.size;
  }

  /** Every record, in ascending key order (code units). */
  entries(): [string, string][] {
    return [...this.#records.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

/**
 * The store's deterministic byte image: a header line `{"records":N,"scheme":…}`, then one line per record,
 * `["key","value"]` (JSON), in ascending key order, each ending in a newline. Same records, same bytes.
 */
export async function encodeReadModelImage(store: InMemoryClaimReadModelStore): Promise<{ bytes: Uint8Array; sha256: string }> {
  const lines = [json({ scheme: CLAIM_READ_MODEL_IMAGE_SCHEME, records: store.size }), ...store.entries().map((e) => JSON.stringify(e))];
  const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
  return { bytes, sha256: await contentHash(bytes) };
}

/** Loads an image, checking its SHA-256 first and then its format strictly. */
export async function decodeReadModelImage(bytes: Uint8Array, expectedSha256: string): Promise<InMemoryClaimReadModelStore> {
  if (!(bytes instanceof Uint8Array)) return fail("invalid_image", "an image is bytes");
  const actual = await contentHash(bytes);
  if (actual !== expectedSha256) fail("image_hash_mismatch", `the image hashes to ${actual}, not ${String(expectedSha256)}`);
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid_image", "the image is not UTF-8");
  }
  if (!text.endsWith("\n")) fail("invalid_image", "the image must end with a newline");
  const lines = text.slice(0, -1).split("\n");
  let head: Record<string, unknown> = {};
  try {
    head = JSON.parse(lines[0]!) as Record<string, unknown>;
  } catch {
    fail("invalid_image", "the image header is not JSON");
  }
  if (head.scheme !== CLAIM_READ_MODEL_IMAGE_SCHEME || head.records !== lines.length - 1 || Object.keys(head).length !== 2) fail("invalid_image", "the image header does not match its records");
  const store = new InMemoryClaimReadModelStore();
  let previous: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    let rec: unknown;
    try {
      rec = JSON.parse(lines[i]!);
    } catch {
      fail("invalid_image", `line ${i + 1} is not JSON`);
    }
    if (!Array.isArray(rec) || rec.length !== 2 || typeof rec[0] !== "string" || typeof rec[1] !== "string" || JSON.stringify(rec) !== lines[i]) fail("invalid_image", `line ${i + 1} is not a canonical [key, value] pair`);
    const [key, value] = rec as [string, string];
    if (previous !== null && !(previous < key)) fail("invalid_image", `line ${i + 1}: keys must be strictly ascending`);
    previous = key;
    await store.put(key, value);
  }
  return store;
}
