/**
 * Unsigned simulation claim intents (Y13, simulation only). An intent is **data**: it says which persisted leaf of
 * which frozen artifact set a recipient could claim, with the proof that leaf verifies under the set's root. It is
 * never signed, carries no rail-specific payout fields beyond the leaf's own payout address and mint, and cannot be
 * submitted anywhere (no claims are possible before funding and a payout rail are approved: D-25, D-27).
 *
 * Built only from stored data (migration 0027), never recomputed: the caller passes the stored leaves after
 * verifying each proof; this module only arranges them canonically. Determinism: one stored artifact set gives the
 * same batch byte for byte. `createdAt` is the stored artifact's own time (fixed per set), not the time of the
 * request, so a regenerated batch is identical.
 */
import { assertExactKeys } from "./amounts";
import { canonicalYieldArtifact, yieldArtifactHash } from "./artifact";

export const CLAIM_INTENT_SCHEME = "metafarm-yield-claim-intent/1";
export const CLAIM_INTENT_BATCH_SCHEME = "metafarm-yield-claim-intent-batch/1";
/** Bumped only together with a new scheme. */
export const CLAIM_INTENT_VERSION = 1;

export interface UnsignedClaimIntent {
  scheme: typeof CLAIM_INTENT_SCHEME;
  version: typeof CLAIM_INTENT_VERSION;
  /** Always false: an intent is never signed by the platform. */
  signed: false;
  simulation: true;
  /** The leaf's network registry name; simulation networks only. */
  network: string;
  cycleId: string;
  cycleVersion: number;
  setNumber: number;
  /** The frozen artifact set this intent belongs to (its SHA-256 is the stored artifact's). */
  artifactSetHash: string;
  merkleRoot: string;
  treeSize: number;
  leafIndex: number;
  leafHash: string;
  /** Hex of the stored leaf bytes. */
  leafBytes: string;
  /** RFC 9162 audit path, nearest sibling first, as stored; `pathSha256` is the SHA-256 of its canonical JSON. */
  proof: { hasherId: string; path: string[]; pathSha256: string };
  partyId: string;
  /** Hex of the 32 recipient bytes in the leaf, and the address they come from. */
  recipient: string;
  payoutAddress: string;
  /** Settlement base units (u64, as in the leaf). */
  amount: bigint;
  payoutMint: string;
  economicAssetId: string;
  /** The stored artifact's creation time (RFC 3339, UTC). */
  createdAt: string;
}

export interface ClaimIntentBatch {
  scheme: typeof CLAIM_INTENT_BATCH_SCHEME;
  version: typeof CLAIM_INTENT_VERSION;
  signed: false;
  simulation: true;
  network: string;
  cycleId: string;
  cycleVersion: number;
  setNumber: number;
  artifactSetHash: string;
  merkleRoot: string;
  treeSize: number;
  createdAt: string;
  /** By leaf index. */
  intents: UnsignedClaimIntent[];
}

export interface StoredLeafForIntent {
  leafIndex: number;
  treeSize: number;
  leafHash: string;
  leafBytes: string;
  path: string[];
  hasherId: string;
  partyId: string;
  recipient: string;
  payoutWallet: string;
  amount: bigint;
}

export class ClaimIntentError extends Error {
  constructor(
    readonly code: "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "ClaimIntentError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Arranges verified stored leaves into the canonical batch. The caller has already verified every proof against
 * `merkleRoot` and checked the leaves against the stored artifact; this refuses only malformed input.
 */
export async function buildClaimIntentBatch(input: {
  network: string;
  cycleId: string;
  cycleVersion: number;
  setNumber: number;
  artifactSetHash: string;
  merkleRoot: string;
  createdAt: string;
  payoutMint: string;
  economicAssetId: string;
  leaves: readonly StoredLeafForIntent[];
}): Promise<{ batch: ClaimIntentBatch; canonical: string; sha256: string }> {
  assertExactKeys("intent batch input", input, ["network", "cycleId", "cycleVersion", "setNumber", "artifactSetHash", "merkleRoot", "createdAt", "payoutMint", "economicAssetId", "leaves"]);
  if (!HEX64.test(input.artifactSetHash) || !HEX64.test(input.merkleRoot)) throw new ClaimIntentError("invalid_input", "set hash and root must be 64 lowercase hex");
  if (input.leaves.length === 0) throw new ClaimIntentError("invalid_input", "a batch needs at least one leaf");
  const leaves = [...input.leaves].sort((a, b) => a.leafIndex - b.leafIndex);
  const treeSize = leaves[0]!.treeSize;
  for (const [i, l] of leaves.entries()) {
    if (l.leafIndex !== i || l.treeSize !== treeSize || l.treeSize !== leaves.length) throw new ClaimIntentError("invalid_input", `leaf ${l.leafIndex} is not leaf ${i} of a ${leaves.length}-leaf tree`);
    if (l.amount <= 0n) throw new ClaimIntentError("invalid_input", `leaf ${l.leafIndex} pays nothing`);
  }
  const intents: UnsignedClaimIntent[] = [];
  for (const l of leaves)
    intents.push({
      scheme: CLAIM_INTENT_SCHEME,
      version: CLAIM_INTENT_VERSION,
      signed: false,
      simulation: true,
      network: input.network,
      cycleId: input.cycleId,
      cycleVersion: input.cycleVersion,
      setNumber: input.setNumber,
      artifactSetHash: input.artifactSetHash,
      merkleRoot: input.merkleRoot,
      treeSize,
      leafIndex: l.leafIndex,
      leafHash: l.leafHash,
      leafBytes: l.leafBytes,
      proof: { hasherId: l.hasherId, path: [...l.path], pathSha256: await yieldArtifactHash(l.path) },
      partyId: l.partyId,
      recipient: l.recipient,
      payoutAddress: l.payoutWallet,
      amount: l.amount,
      payoutMint: input.payoutMint,
      economicAssetId: input.economicAssetId,
      createdAt: input.createdAt,
    });
  const batch: ClaimIntentBatch = {
    scheme: CLAIM_INTENT_BATCH_SCHEME,
    version: CLAIM_INTENT_VERSION,
    signed: false,
    simulation: true,
    network: input.network,
    cycleId: input.cycleId,
    cycleVersion: input.cycleVersion,
    setNumber: input.setNumber,
    artifactSetHash: input.artifactSetHash,
    merkleRoot: input.merkleRoot,
    treeSize,
    createdAt: input.createdAt,
    intents,
  };
  return { batch, canonical: canonicalYieldArtifact(batch), sha256: await yieldArtifactHash(batch) };
}
