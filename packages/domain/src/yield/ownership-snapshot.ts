/**
 * Ownership snapshot verification (simulation only). A pure, fail-closed check of an ownership snapshot
 * supplied as data: raw u64 share units per party, canonical order, exact integer totals, and a SHA-256
 * commitment the cycle pipeline binds into every claim leaf (leaf layout 2).
 *
 * This is **not** the verified ownership index of plan Y0/Y5: nothing here reads a chain, an indexer or an
 * RPC endpoint, and a snapshot's contents are only as trustworthy as whoever produced them. What it does
 * guarantee is that the exact snapshot a cycle used is committed to, and that any change to it is detected.
 *
 * Rules (each refusal is an `OwnershipSnapshotError`):
 * - only simulation network identifiers (`SIMULATION_NETWORK_IDS`); anything else, mainnet included, is
 *   refused;
 * - raw shares are bigints with 0 < shares ≤ 2^64 − 1; the total is an exact bigint sum and must be > 0;
 * - party ids are unique and **already** in canonical order (ascending UTF-16 code units); unsorted input is
 *   refused, never re-sorted silently. Unattributed holdings likewise, by holder key;
 * - payout addresses (Solana base58 or 64 hex) are unique after normalisation to their 32 bytes, so two
 *   spellings of one address are a duplicate. A party may have no payout address (`null`): its share is
 *   recorded and later withheld or refused as the distribution policy says (D-14);
 * - unsupported keys are refused.
 *
 * Commitment: SHA-256 of the canonical JSON of { scheme, snapshotId, assetId (hex), networkId, reference,
 * entries [{ partyId, recipient (hex | null), rawShares, metadata | null }], unattributed [...] }. The
 * original address spelling, the verification time and the diagnostics are not part of it.
 */
import { U64_MAX, assertExactKeys } from "./amounts";
import { canonicalYieldArtifact, yieldArtifactHash } from "./artifact";
import { decodeKey32 } from "./claim-tree";
import { isRfc3339WithOffset } from "./evidence";

export const OWNERSHIP_SNAPSHOT_SCHEME = "metafarm-yield-ownership-snapshot/1";

/** The only network identifiers a snapshot may name. Real networks are refused (simulation only). */
export const SIMULATION_NETWORK_IDS = ["simulation", "solana-localnet"] as const;
export type SimulationNetworkId = (typeof SIMULATION_NETWORK_IDS)[number];

export const SNAPSHOT_REFERENCE_KINDS = ["slot", "block_height"] as const;

export interface OwnershipSnapshotInput {
  /** Lowercase RFC 4122 UUID. */
  snapshotId: string;
  /** The economic asset (Token-2022 mint or compressed-NFT id): base58 or 64 hex, 32 bytes. */
  assetId: string;
  networkId: string;
  /** Where in the chain's history the snapshot was taken, and when that point was observed. */
  reference: { kind: (typeof SNAPSHOT_REFERENCE_KINDS)[number]; value: bigint; observedAt: string };
  /** Canonical order: ascending party id. */
  entries: { partyId: string; payoutAddress: string | null; rawShares: bigint; metadata?: Record<string, string> }[];
  /** Holdings no party is attributed to. Canonical order: ascending holder key. */
  unattributed: { holderKey: string; rawShares: bigint }[];
}

export interface VerifiedOwnershipEntry {
  partyId: string;
  /** The address as supplied, or null when the party has none. */
  payoutAddress: string | null;
  /** Hex of the address's 32 bytes, or null. */
  recipient: string | null;
  rawShares: bigint;
  metadata: Record<string, string> | null;
  /** The party's exact proportional basis: rawShares / totalRawShares, kept as integers. */
  shareBasis: { numerator: bigint; denominator: bigint };
}

export interface VerifiedOwnershipSnapshot {
  scheme: typeof OWNERSHIP_SNAPSHOT_SCHEME;
  snapshotId: string;
  /** Hex of the asset's 32 bytes. */
  assetId: string;
  networkId: SimulationNetworkId;
  reference: { kind: (typeof SNAPSHOT_REFERENCE_KINDS)[number]; value: bigint; observedAt: string };
  snapshotHash: string;
  totalRawShares: bigint;
  entries: VerifiedOwnershipEntry[];
  unattributed: { holderKey: string; rawShares: bigint; shareBasis: { numerator: bigint; denominator: bigint } }[];
  /** Supplied by the caller (the library reads no clock). */
  verifiedAt: string;
  diagnostics: { partyCount: number; withheldCount: number; unattributedCount: number; unattributedRawShares: bigint; minRawShares: bigint; maxRawShares: bigint };
}

export type OwnershipSnapshotErrorCode =
  | "invalid_snapshot"
  | "real_network"
  | "invalid_shares"
  | "duplicate_party"
  | "duplicate_payout_address"
  | "duplicate_holder"
  | "not_canonical_order"
  | "zero_total"
  | "hash_mismatch";

export class OwnershipSnapshotError extends Error {
  constructor(
    readonly code: OwnershipSnapshotErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OwnershipSnapshotError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "" && v.trim() === v && v.length <= 256;
const hexOf = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const fail = (code: OwnershipSnapshotErrorCode, message: string): never => {
  throw new OwnershipSnapshotError(code, message);
};

function shares(name: string, v: unknown): bigint {
  if (typeof v !== "bigint") return fail("invalid_shares", `${name} must be a bigint (raw u64 share units), got ${typeof v}`);
  if (v <= 0n) return fail("invalid_shares", `${name} must be greater than zero`);
  if (v > U64_MAX) return fail("invalid_shares", `${name} does not fit u64`);
  return v;
}

function metadataOf(name: string, v: unknown): Record<string, string> | null {
  if (v === undefined) return null;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return fail("invalid_snapshot", `${name} must be a plain object of strings`);
  const keys = Object.keys(v);
  if (keys.length > 16) return fail("invalid_snapshot", `${name} has more than 16 keys`);
  const out: Record<string, string> = {};
  for (const k of keys.sort()) {
    const x = (v as Record<string, unknown>)[k];
    if (!nonEmpty(k) || typeof x !== "string" || x.length > 256) return fail("invalid_snapshot", `${name}.${k} must be a string of at most 256 characters`);
    out[k] = x;
  }
  return out;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

/** The committed content of a snapshot (what `snapshotHash` covers). */
function committedContent(s: Pick<VerifiedOwnershipSnapshot, "snapshotId" | "assetId" | "networkId" | "reference" | "entries" | "unattributed">) {
  return {
    scheme: OWNERSHIP_SNAPSHOT_SCHEME,
    snapshotId: s.snapshotId,
    assetId: s.assetId,
    networkId: s.networkId,
    reference: { kind: s.reference.kind, value: s.reference.value, observedAt: s.reference.observedAt },
    entries: s.entries.map((e) => ({ partyId: e.partyId, recipient: e.recipient, rawShares: e.rawShares, metadata: e.metadata })),
    unattributed: s.unattributed.map((u) => ({ holderKey: u.holderKey, rawShares: u.rawShares })),
  };
}

/** Canonical JSON of a snapshot's committed content. */
export function canonicalOwnershipSnapshot(s: VerifiedOwnershipSnapshot): string {
  return canonicalYieldArtifact(committedContent(s));
}

/** Verifies a snapshot and returns it normalised, with its commitment, deeply frozen. */
export async function verifyAndNormalizeSnapshot(input: OwnershipSnapshotInput, options: { verifiedAt: string }): Promise<VerifiedOwnershipSnapshot> {
  try {
    assertExactKeys("snapshot", input, ["snapshotId", "assetId", "networkId", "reference", "entries", "unattributed"]);
    assertExactKeys("options", options, ["verifiedAt"]);
  } catch (e) {
    fail("invalid_snapshot", (e as Error).message);
  }
  if (typeof input.snapshotId !== "string" || !UUID.test(input.snapshotId)) fail("invalid_snapshot", "snapshotId must be a lowercase RFC 4122 UUID");
  if (!(SIMULATION_NETWORK_IDS as readonly unknown[]).includes(input.networkId))
    fail("real_network", `network ${String(input.networkId)} is not a simulation network (${SIMULATION_NETWORK_IDS.join(", ")}); real networks are refused`);
  let assetId = "";
  try {
    assetId = hexOf(decodeKey32("assetId", input.assetId));
  } catch (e) {
    fail("invalid_snapshot", (e as Error).message);
  }
  const ref = input.reference as Record<string, unknown> | undefined;
  if (!ref || typeof ref !== "object") fail("invalid_snapshot", "reference is required");
  const extraRef = Object.keys(ref!).filter((k) => !["kind", "value", "observedAt"].includes(k));
  if (extraRef.length) fail("invalid_snapshot", `reference has unsupported keys: ${extraRef.sort().join(", ")}`);
  if (!(SNAPSHOT_REFERENCE_KINDS as readonly unknown[]).includes(ref!.kind)) fail("invalid_snapshot", `reference.kind must be one of ${SNAPSHOT_REFERENCE_KINDS.join(", ")}`);
  if (typeof ref!.value !== "bigint" || ref!.value < 0n || ref!.value > U64_MAX) fail("invalid_snapshot", "reference.value must be a u64 bigint");
  if (!isRfc3339WithOffset(ref!.observedAt)) fail("invalid_snapshot", "reference.observedAt must be RFC 3339 with an offset");
  if (!isRfc3339WithOffset(options.verifiedAt)) fail("invalid_snapshot", "verifiedAt must be RFC 3339 with an offset");
  if (!Array.isArray(input.entries) || !Array.isArray(input.unattributed)) fail("invalid_snapshot", "entries and unattributed must be lists");

  // Parties: valid, unique, already in canonical order; addresses unique after normalisation.
  const seenParty = new Set<string>();
  const seenRecipient = new Map<string, string>();
  const parsed = input.entries.map((e, i) => {
    try {
      assertExactKeys(`entries[${i}]`, e as unknown, ["partyId", "payoutAddress", "rawShares", "metadata"]);
    } catch (err) {
      fail("invalid_snapshot", (err as Error).message);
    }
    if (!nonEmpty(e.partyId)) fail("invalid_snapshot", `entries[${i}].partyId must be a non-empty string without surrounding whitespace`);
    if (seenParty.has(e.partyId)) fail("duplicate_party", `party ${e.partyId} appears twice`);
    seenParty.add(e.partyId);
    if (!Object.prototype.hasOwnProperty.call(e, "payoutAddress")) fail("invalid_snapshot", `entries[${i}].payoutAddress must be given (null for none)`);
    let recipient: string | null = null;
    if (e.payoutAddress !== null) {
      try {
        recipient = hexOf(decodeKey32(`payout address of ${e.partyId}`, e.payoutAddress));
      } catch (err) {
        fail("invalid_snapshot", (err as Error).message);
      }
      const other = seenRecipient.get(recipient!);
      if (other !== undefined) fail("duplicate_payout_address", `parties ${other} and ${e.partyId} have the same payout address`);
      seenRecipient.set(recipient!, e.partyId);
    }
    return { partyId: e.partyId, payoutAddress: e.payoutAddress, recipient, rawShares: shares(`raw shares of ${e.partyId}`, e.rawShares), metadata: metadataOf(`metadata of ${e.partyId}`, e.metadata) };
  });
  for (let i = 1; i < parsed.length; i++)
    if (!(parsed[i - 1]!.partyId < parsed[i]!.partyId)) fail("not_canonical_order", `entries must be in ascending party id order: ${parsed[i - 1]!.partyId} comes before ${parsed[i]!.partyId}`);

  const seenHolder = new Set<string>();
  const unattributed = input.unattributed.map((u, i) => {
    try {
      assertExactKeys(`unattributed[${i}]`, u as unknown, ["holderKey", "rawShares"]);
    } catch (err) {
      fail("invalid_snapshot", (err as Error).message);
    }
    if (!nonEmpty(u.holderKey)) fail("invalid_snapshot", `unattributed[${i}].holderKey must be a non-empty string`);
    if (seenHolder.has(u.holderKey)) fail("duplicate_holder", `holder ${u.holderKey} appears twice`);
    if (seenParty.has(u.holderKey)) fail("duplicate_holder", `holder key ${u.holderKey} is also a party id`);
    seenHolder.add(u.holderKey);
    return { holderKey: u.holderKey, rawShares: shares(`raw shares of ${u.holderKey}`, u.rawShares) };
  });
  for (let i = 1; i < unattributed.length; i++)
    if (!(unattributed[i - 1]!.holderKey < unattributed[i]!.holderKey)) fail("not_canonical_order", "unattributed holdings must be in ascending holder key order");

  const all = [...parsed.map((p) => p.rawShares), ...unattributed.map((u) => u.rawShares)];
  const totalRawShares = all.reduce((n, x) => n + x, 0n);
  if (totalRawShares === 0n) fail("zero_total", "the snapshot holds no shares");

  const base = {
    snapshotId: input.snapshotId,
    assetId,
    networkId: input.networkId as SimulationNetworkId,
    reference: { kind: ref!.kind as (typeof SNAPSHOT_REFERENCE_KINDS)[number], value: ref!.value as bigint, observedAt: ref!.observedAt as string },
    entries: parsed.map((p) => ({ ...p, shareBasis: { numerator: p.rawShares, denominator: totalRawShares } })),
    unattributed: unattributed.map((u) => ({ ...u, shareBasis: { numerator: u.rawShares, denominator: totalRawShares } })),
  };
  const snapshot: VerifiedOwnershipSnapshot = {
    scheme: OWNERSHIP_SNAPSHOT_SCHEME,
    ...base,
    snapshotHash: await yieldArtifactHash(committedContent(base)),
    totalRawShares,
    verifiedAt: options.verifiedAt,
    diagnostics: {
      partyCount: parsed.length,
      withheldCount: parsed.filter((p) => p.recipient === null).length,
      unattributedCount: unattributed.length,
      unattributedRawShares: unattributed.reduce((n, u) => n + u.rawShares, 0n),
      minRawShares: all.reduce((m, x) => (x < m ? x : m), all[0]!),
      maxRawShares: all.reduce((m, x) => (x > m ? x : m), all[0]!),
    },
  };
  return deepFreeze(snapshot);
}

/**
 * Re-checks a verified snapshot (e.g. one embedded in an artifact): its hash over the committed content,
 * the total, every share basis, the network, and the canonical order. Returns the problems found.
 */
export async function ownershipSnapshotProblems(s: VerifiedOwnershipSnapshot): Promise<string[]> {
  const out: string[] = [];
  if (s?.scheme !== OWNERSHIP_SNAPSHOT_SCHEME) return ["not a verified ownership snapshot"];
  if (!(SIMULATION_NETWORK_IDS as readonly unknown[]).includes(s.networkId)) out.push(`network ${String(s.networkId)} is not a simulation network`);
  try {
    if ((await yieldArtifactHash(committedContent(s))) !== s.snapshotHash) out.push("the snapshot does not hash to its recorded snapshot hash");
  } catch (e) {
    out.push(`the snapshot cannot be hashed: ${(e as Error).message}`);
  }
  const all = [...s.entries.map((e) => e.rawShares), ...s.unattributed.map((u) => u.rawShares)];
  const total = all.reduce((n, x) => n + x, 0n);
  if (total !== s.totalRawShares || total === 0n) out.push("totalRawShares is not the sum of the raw shares");
  if (all.some((x) => typeof x !== "bigint" || x <= 0n || x > U64_MAX)) out.push("raw shares must satisfy 0 < shares ≤ 2^64 − 1");
  for (const b of [...s.entries, ...s.unattributed]) if (b.shareBasis.numerator !== b.rawShares || b.shareBasis.denominator !== s.totalRawShares) out.push("a share basis does not match its raw shares and the total");
  for (let i = 1; i < s.entries.length; i++) if (!(s.entries[i - 1]!.partyId < s.entries[i]!.partyId)) out.push("entries are not in canonical order");
  for (const e of s.entries)
    if (e.payoutAddress === null ? e.recipient !== null : (() => {
      try {
        return hexOf(decodeKey32("payout address", e.payoutAddress)) !== e.recipient;
      } catch {
        return true;
      }
    })())
      out.push(`the recipient of ${e.partyId} does not match its payout address`);
  return [...new Set(out)];
}
