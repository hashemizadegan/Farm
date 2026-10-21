/**
 * Claim lookup over a frozen cycle distribution artifact (PR #73): finds a holder's claim by party id or by
 * payout address and returns the client payload the C# core (`Runtime/Core/Yield`, PR #71) verifies.
 * Pure and in-memory: no database, no network, no signing. Simulation only.
 *
 * The lookup is built from a verified artifact: `createClaimLookup` re-runs the artifact checks (hash,
 * every proof against the published root and size, conservation) and refuses a non-simulation artifact.
 *
 * Wire contract (`metafarm-yield-claim/1`), JSON with these exact keys; every 64-bit amount is a decimal
 * string and every byte string lowercase hex:
 *   scheme, cycleId, cycleVersion, simulation, hasherId, root, treeSize, ownershipSnapshotHash, leafIndex,
 *   partyId, recipient, amount, leafBytes, leafHash, path
 * Leaves use layout 2: each carries the ownership snapshot hash, which must equal the published one.
 * `root` and `treeSize` repeat the published tree for convenience only: a client must verify against the
 * root and size it trusts (the published tree, `publishedClaimTree`), never the ones inside a payload.
 */
import { canonicalJson } from "../harvest";
import { type ClaimTreeHasher, decodeClaimLeaf, decodeKey32, uuidBytes, verifyClaimLeafProof } from "./claim-tree";
import { type CycleDistributionArtifact, cycleArtifactProblems } from "./pipeline";

export const CLAIM_PAYLOAD_SCHEME = "metafarm-yield-claim/1";

export interface ClaimPayloadDto {
  scheme: typeof CLAIM_PAYLOAD_SCHEME;
  cycleId: string;
  cycleVersion: number;
  simulation: true;
  hasherId: string;
  root: string;
  treeSize: number;
  /** The ownership snapshot every leaf of the tree is bound to (64 hex). */
  ownershipSnapshotHash: string;
  leafIndex: number;
  partyId: string;
  /** Hex of the 32 recipient bytes (the payout address). */
  recipient: string;
  /** u64 as a decimal string. */
  amount: string;
  leafBytes: string;
  leafHash: string;
  path: string[];
}

/** The tree a client trusts: taken from the published artifact, not from a claim payload. */
export interface PublishedClaimTree {
  cycleId: string;
  cycleVersion: number;
  simulation: true;
  hasherId: string;
  root: string;
  treeSize: number;
  /** The ownership snapshot hash every leaf must carry. */
  ownershipSnapshotHash: string;
}

export type ClaimLookupResult =
  | { status: "claim"; claim: ClaimPayloadDto }
  /** The holder is in the cycle but has no leaf: dust deferred to a later cycle, or withheld. */
  | { status: "no_leaf"; reason: "deferred" | "withheld" }
  /** An unattributed holding (no party): recorded, never paid until D-13. */
  | { status: "unattributed" }
  | { status: "not_in_cycle" };

export interface ClaimLookup {
  readonly published: PublishedClaimTree | null;
  byPartyId(partyId: string): ClaimLookupResult;
  /** By payout address: a Solana base58 address or 64 lowercase hex characters. */
  byPayoutAddress(address: string): ClaimLookupResult;
  /** Every claim, in leaf order. */
  all(): ClaimPayloadDto[];
}

export class ClaimLookupError extends Error {
  constructor(
    readonly code: "simulation_only" | "artifact_invalid",
    message: string,
  ) {
    super(message);
    this.name = "ClaimLookupError";
  }
}

/** Builds a lookup over a verified, simulation artifact. */
export async function createClaimLookup(artifact: CycleDistributionArtifact, artifactSha256: string, hasher: ClaimTreeHasher): Promise<ClaimLookup> {
  if (artifact?.cycle?.simulation !== true) throw new ClaimLookupError("simulation_only", "claim lookup serves simulation cycles only");
  const problems = await cycleArtifactProblems(artifact, artifactSha256, hasher);
  if (problems.length) throw new ClaimLookupError("artifact_invalid", `the artifact does not verify: ${problems.join("; ")}`);

  const tree = artifact.claimTree;
  const published: PublishedClaimTree | null = tree
    ? { cycleId: artifact.cycle.id, cycleVersion: artifact.cycle.version, simulation: true, hasherId: tree.hasherId, root: tree.root, treeSize: tree.size, ownershipSnapshotHash: artifact.ownership.snapshotHash }
    : null;
  const claims: ClaimPayloadDto[] = (tree?.leaves ?? []).map((l) => ({
    scheme: CLAIM_PAYLOAD_SCHEME,
    cycleId: artifact.cycle.id,
    cycleVersion: artifact.cycle.version,
    simulation: true,
    hasherId: tree!.hasherId,
    root: tree!.root,
    treeSize: tree!.size,
    ownershipSnapshotHash: artifact.ownership.snapshotHash,
    leafIndex: l.leafIndex,
    partyId: l.partyId,
    recipient: l.recipient,
    amount: l.amount.toString(),
    leafBytes: l.leafBytes,
    leafHash: l.leafHash,
    path: [...l.proof.path],
  }));
  for (const c of claims) Object.freeze(Object.freeze(c).path);
  const byParty = new Map(claims.map((c) => [c.partyId, c]));
  const byRecipient = new Map(claims.map((c) => [c.recipient, c]));
  const entries = artifact.distribution.plan.entries;

  const resultFor = (claim: ClaimPayloadDto | undefined, partyId: string | null): ClaimLookupResult => {
    if (claim) return { status: "claim", claim };
    const e = partyId === null ? undefined : entries.find((x) => x.partyId === partyId);
    if (e?.state === "deferred" || e?.state === "withheld") return { status: "no_leaf", reason: e.state };
    if (partyId !== null && artifact.distribution.plan.ledgerOut.deferred.some((d) => d.partyId === partyId)) return { status: "no_leaf", reason: "deferred" };
    return { status: "not_in_cycle" };
  };

  return Object.freeze({
    published: published && Object.freeze(published),
    byPartyId(partyId: string) {
      if (typeof partyId !== "string" || partyId === "") return { status: "not_in_cycle" as const };
      // An identity that is not a party but matches an unattributed holding's key.
      const isParty = entries.some((e) => e.partyId === partyId);
      if (!isParty && entries.some((e) => e.kind === "unattributed" && e.holderKey === partyId)) return { status: "unattributed" as const };
      return resultFor(byParty.get(partyId), partyId);
    },
    byPayoutAddress(address: string) {
      let hex: string;
      try {
        hex = [...decodeKey32("payout address", address)].map((b) => b.toString(16).padStart(2, "0")).join("");
      } catch {
        return { status: "not_in_cycle" as const };
      }
      const claim = byRecipient.get(hex);
      if (claim) return { status: "claim" as const, claim };
      const e = entries.find((x) => x.payoutWallet !== null && x.kind === "party" && safeHex(x.payoutWallet) === hex);
      return resultFor(undefined, e?.partyId ?? null);
    },
    all() {
      return [...claims];
    },
  });
}

function safeHex(address: string): string | null {
  try {
    return [...decodeKey32("payout address", address)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** The payload's wire form: canonical JSON (keys sorted, no whitespace). */
export function serializeClaimPayload(dto: ClaimPayloadDto): string {
  return canonicalJson(dto);
}

/**
 * Verifies a claim payload against a trusted published tree, exactly as the C# client does
 * (`ClaimPayloadVerification`): simulation only, same cycle and hasher, the payload's root and size equal
 * the trusted ones, the leaf decodes to the published cycle id and version, the published ownership snapshot
 * hash, and the payload's index, recipient and amount, and the proof verifies.
 */
export async function verifyClaimPayload(dto: ClaimPayloadDto, published: PublishedClaimTree, hasher: ClaimTreeHasher): Promise<boolean> {
  if (dto?.scheme !== CLAIM_PAYLOAD_SCHEME || dto.simulation !== true || published?.simulation !== true) return false;
  if (dto.cycleId !== published.cycleId || dto.cycleVersion !== published.cycleVersion || dto.hasherId !== published.hasherId || hasher.id !== published.hasherId) return false;
  if (typeof published.ownershipSnapshotHash !== "string" || dto.ownershipSnapshotHash !== published.ownershipSnapshotHash) return false;
  if (typeof dto.leafBytes !== "string" || !/^[0-9a-f]{466}$/.test(dto.leafBytes) || typeof dto.amount !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(dto.amount)) return false;
  const bytes = Uint8Array.from(dto.leafBytes.match(/../g)!.map((x) => parseInt(x, 16)));
  let leaf;
  try {
    leaf = await decodeClaimLeaf(bytes);
  } catch {
    return false;
  }
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  let cycleId: Uint8Array;
  try {
    cycleId = uuidBytes(published.cycleId);
  } catch {
    return false;
  }
  // The leaf itself must name this cycle and version, this recipient and this amount.
  if (hex(leaf.cycleId) !== hex(cycleId) || leaf.cycleVersion !== published.cycleVersion) return false;
  if (hex(leaf.recipient) !== dto.recipient || leaf.amount.toString() !== dto.amount) return false;
  // Layout 2: the leaf itself names the ownership snapshot.
  if (!leaf.ownershipSnapshotHash || hex(leaf.ownershipSnapshotHash) !== published.ownershipSnapshotHash) return false;
  return verifyClaimLeafProof(hasher, bytes, { leafIndex: dto.leafIndex, treeSize: dto.treeSize, leafHash: dto.leafHash, path: dto.path, root: dto.root }, { root: published.root, treeSize: published.treeSize });
}
