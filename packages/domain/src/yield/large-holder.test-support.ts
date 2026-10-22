/**
 * Large-holder simulation cycles (layout 2 leaves) for envelope tests, and the C# sample built from one.
 * Everything here is deterministic: seeded synthetic ownership (MockOwnershipAdapter), no clock, no network,
 * no storage. Simulation records only.
 */
import { canonicalYieldArtifact } from "./artifact";
import { type ClaimTreeHasher, SHA256_RFC9162_HASHER } from "./claim-tree";
import { createClaimLookup } from "./claim-lookup";
import { SIMULATION_DISTRIBUTION_POLICY } from "./distribution";
import { MockOwnershipAdapter, type OwnershipSnapshotRequest, loadVerifiedOwnershipSnapshot } from "./ownership-source";
import { SYNTHETIC_SHARE_PROFILES, type SyntheticShareProfile, splitMix64 } from "./ownership-synthetic";
import { U64_MAX } from "./amounts";
import { calculateSimulationCycle } from "./pipeline";
import { input } from "./pipeline.scenario.test-support";

export const LARGE_REQUEST: OwnershipSnapshotRequest = { assetId: "bb".repeat(32), networkId: "simulation", reference: { kind: "slot", value: 270_000_000n }, verifiedAt: "2026-10-01T09:00:00Z" };

/** A SHA-256 RFC 9162 hasher (same id and output) that counts its calls. */
export function countingHasher(): ClaimTreeHasher & { counts: { leaf: number; node: number } } {
  const counts = { leaf: 0, node: 0 };
  return {
    id: SHA256_RFC9162_HASHER.id,
    counts,
    leaf: (b) => {
      counts.leaf++;
      return SHA256_RFC9162_HASHER.leaf(b);
    },
    node: (l, r) => {
      counts.node++;
      return SHA256_RFC9162_HASHER.node(l, r);
    },
  };
}

/** RFC 9162 audit path length of leaf `i` in a tree of `n` leaves, from the definition (largest power of two below n). */
export function rfc9162PathLength(i: number, n: number): number {
  if (n <= 1) return 0;
  let k = 1;
  while (k * 2 < n) k *= 2;
  return 1 + (i < k ? rfc9162PathLength(i, k) : rfc9162PathLength(i - k, n - k));
}

/**
 * Runs a seeded extreme-profile cycle. With the default dust threshold 0, zero_amount deferrals occur; a positive
 * threshold also produces below_dust_threshold deferrals.
 */
export async function largeHolderCycle(holders: number, seed: bigint, hasher: ClaimTreeHasher = SHA256_RFC9162_HASHER, dustThreshold = 0n, profile: SyntheticShareProfile = "extreme") {
  const ownership = await loadVerifiedOwnershipSnapshot(new MockOwnershipAdapter({ seed, holders, profile, withheldEvery: 97, unattributed: 3, observedAt: "2026-09-30T23:59:59Z" }), LARGE_REQUEST);
  const base = await input();
  const result = await calculateSimulationCycle({ ...base, ownership, hasher, distributionPolicy: { ...SIMULATION_DISTRIBUTION_POLICY, dustThreshold, missingPayoutWallet: "withhold" } });
  return { ownership, input: base, ...result };
}

// ── One deterministic cycle per parameter set, shared in-process ────────────────────────────────

/** Everything that determines a shared cycle (the request, policies and hasher are fixed). */
export interface LargeCycleParams {
  holders: number;
  seed: bigint;
  profile: SyntheticShareProfile;
  dustThreshold: bigint;
}

/**
 * The 16,384-holder cycle shared by the #78 envelope tests and the #79 read-model tests. Dust threshold 1,000,
 * so every holder state (claim, withheld, zero_amount, below_dust_threshold) occurs.
 */
export const SHARED_16K: LargeCycleParams = Object.freeze({ holders: 16_384, seed: 0xe17e10e5n, profile: "extreme", dustThreshold: 1_000n });

/** The memo key: every parameter that changes the cycle. */
export function largeCycleKey(p: LargeCycleParams): string {
  return `holders=${p.holders};seed=0x${p.seed.toString(16)};profile=${p.profile};dustThreshold=${p.dustThreshold}`;
}

function assertLargeCycleParams(p: LargeCycleParams): void {
  const keys = Object.keys(p).sort().join(",");
  if (keys !== "dustThreshold,holders,profile,seed") throw new Error(`shared cycle parameters must be exactly holders, seed, profile, dustThreshold (got ${keys})`);
  if (!Number.isSafeInteger(p.holders) || p.holders < 1) throw new Error("holders must be a positive integer");
  if (typeof p.seed !== "bigint" || p.seed < 0n || p.seed > U64_MAX) throw new Error("seed must be a u64 bigint");
  if (!(SYNTHETIC_SHARE_PROFILES as readonly string[]).includes(p.profile)) throw new Error(`profile must be one of ${SYNTHETIC_SHARE_PROFILES.join(", ")}`);
  if (typeof p.dustThreshold !== "bigint" || p.dustThreshold < 0n) throw new Error("dustThreshold must be a non-negative bigint");
}

function _deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) _deepFreeze(x);
  }
  return v;
}

export type SharedLargeCycle = Awaited<ReturnType<typeof largeHolderCycle>>;

/**
 * The in-process memo, on globalThis so it survives module re-evaluation. vitest isolates modules per test file
 * and runs files in parallel workers, so each file that needs a cycle builds it once (same parameters, same
 * frozen bytes in every file); within a file, every test reuses that build. Sharing one build across files would
 * need them in one process, which serializes them and was measured slower in CI (#80). Nothing is written to
 * files, databases or the network.
 */
const MEMO = Symbol.for("metafarm.yield.test.sharedLargeCycles");
const memo = (): Map<string, Promise<SharedLargeCycle>> => ((globalThis as Record<symbol, unknown>)[MEMO] ??= new Map()) as Map<string, Promise<SharedLargeCycle>>;

/**
 * Builds (once per process and parameter set) a seeded simulation cycle with the SHA-256 RFC 9162 hasher, and
 * returns it deeply frozen, so no test can change what another test sees. Simulation only: the ownership
 * request names the simulation network and the pipeline refuses anything else.
 */
export function sharedLargeCycle(p: LargeCycleParams): Promise<SharedLargeCycle> {
  assertLargeCycleParams(p);
  const key = largeCycleKey(p);
  const cache = memo();
  let entry = cache.get(key);
  if (!entry) {
    entry = largeHolderCycle(p.holders, p.seed, SHA256_RFC9162_HASHER, p.dustThreshold, p.profile).then((r) => {
      if (r.artifact.cycle.simulation !== true || r.ownership.networkId !== "simulation") throw new Error("shared cycles are simulation only");
      return Object.freeze(r); // DIAGNOSTIC: shallow freeze only
    });
    // A failed build is not cached, so a later call retries rather than reusing an error.
    entry.catch(() => cache.delete(key));
    cache.set(key, entry);
  }
  return entry;
}

/** The shared 16,384-holder cycle. */
export const sharedCycle16k = () => sharedLargeCycle(SHARED_16K);

/** Keys currently memoized in this process (for the memoization test). */
export const sharedLargeCycleKeys = (): string[] => [...memo().keys()];

/** `count` distinct party ids picked by a seeded generator (no randomness source). */
export function pickParties(partyIds: readonly string[], count: number, seed: bigint): string[] {
  const next = splitMix64(seed);
  const picked = new Set<string>();
  while (picked.size < Math.min(count, partyIds.length)) picked.add(partyIds[Number(next() % BigInt(partyIds.length))]!);
  return [...picked].sort();
}

export const LARGE_SAMPLE = { holders: 4_096, seed: 0x4096n, pickSeed: 0x5e1ecn, picks: 64 } as const;

/**
 * Builds `clients/unity-starter/Samples/claim-payloads.large-tree.sample.json`: 64 seeded holders of a
 * 4,096-holder cycle, with their lookup results; the payable ones carry claim payloads with proofs of
 * depth ~12 against a tree of thousands of leaves.
 */
export async function largeTreeSample() {
  const { artifact, artifactSha256, ownership } = await largeHolderCycle(LARGE_SAMPLE.holders, LARGE_SAMPLE.seed);
  const lookup = await createClaimLookup(artifact, artifactSha256, SHA256_RFC9162_HASHER);
  const picked = pickParties(
    ownership.entries.map((e) => e.partyId),
    LARGE_SAMPLE.picks,
    LARGE_SAMPLE.pickSeed,
  );
  const results = picked.map((partyId) => ({ partyId, result: lookup.byPartyId(partyId) }));
  const t = artifact.totals;
  return {
    description:
      "64 holders picked by a seeded generator (splitMix64 0x5e1ec) from a 4,096-holder simulation cycle (MockOwnershipAdapter seed 0x4096, extreme u64 shares, every 97th withheld, 3 unattributed, dust threshold 0), with their claim lookup results. Payable holders carry claim payloads (proof depth up to 12); holders allocated 0 are deferred with deferredReason zero_amount and have no claim. Generated by large-holder.test-support.ts. Simulation only.",
    artifactSha256,
    artifactCanonicalBytes: new TextEncoder().encode(canonicalYieldArtifact(artifact)).length,
    totals: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.toString()])),
    payableCount: artifact.distribution.plan.entries.filter((e) => e.state === "payable").length,
    publishedTree: lookup.published,
    lookups: results.map(({ partyId, result }) =>
      result.status === "claim" ? { partyId, status: "claim" } : result.status === "no_leaf" ? { partyId, status: "no_leaf", reason: result.reason, ...(result.reason === "deferred" ? { deferredReason: result.deferredReason } : {}) } : { partyId, status: result.status },
    ),
    claims: results.flatMap(({ result }) => (result.status === "claim" ? [result.claim] : [])),
  };
}

export async function largeTreeSampleText(): Promise<string> {
  return `${JSON.stringify(await largeTreeSample(), null, 2)}\n`;
}
