/**
 * Synthetic ownership datasets for simulation and stress testing. Pure and deterministic: a seed and a set of
 * parameters always give the same canonical `OwnershipSnapshotInput`, already in canonical order, so it passes
 * `verifyAndNormalizeSnapshot` without re-sorting. No clock, no randomness source, no network, no floating
 * point: the generator is SplitMix64 over bigints.
 *
 * Generated datasets only ever name a simulation network; asking for any other network is refused before
 * anything is generated.
 *
 * Layout of a generated dataset (for `holders` = n):
 * - party ids `holder-000001` … zero-padded to 6 digits, so lexical order is numeric order (n ≤ 999,999);
 * - payout addresses are 32 bytes in hex: the 1-based holder index in the first 4 bytes (big-endian), so
 *   they are unique by construction, then 28 seeded bytes;
 * - every `withheldEvery`-th holder (if set) has no payout address;
 * - `unattributed` holdings get keys `unattributed-000001` …, which sort after every `holder-` id and
 *   cannot collide with one;
 * - raw shares are u64 values drawn from the chosen profile (all > 0).
 */
import { U64_MAX, assertExactKeys } from "./amounts";
import { SIMULATION_NETWORK_IDS, type OwnershipSnapshotInput, OwnershipSnapshotError } from "./ownership-snapshot";

export const SYNTHETIC_SHARE_PROFILES = ["uniform", "skewed", "extreme"] as const;
export type SyntheticShareProfile = (typeof SYNTHETIC_SHARE_PROFILES)[number];

/** The largest dataset the generator produces (6-digit party ids). */
export const SYNTHETIC_MAX_HOLDERS = 999_999;

export interface SyntheticOwnershipParams {
  seed: bigint;
  holders: number;
  /**
   * - `uniform`: 1 … 1,000,000 units each;
   * - `skewed`: 1 … 2^48 units with a spread of magnitudes (a few large holders, many small ones);
   * - `extreme`: a mix of 1, near-2^64 − 1 and full-range u64 values, so totals exceed u64.
   */
  profile: SyntheticShareProfile;
  /** Every k-th holder has no payout address (0: none). */
  withheldEvery: number;
  /** Number of unattributed holdings (0 or more). */
  unattributed: number;
  assetId: string;
  networkId: string;
  reference: OwnershipSnapshotInput["reference"];
}

const MASK = U64_MAX;

/** SplitMix64 over bigints: deterministic, integer only. */
export function splitMix64(seed: bigint): () => bigint {
  let state = seed & MASK;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return z ^ (z >> 31n);
  };
}

const hex64 = (v: bigint) => v.toString(16).padStart(16, "0");
const pad6 = (n: number) => String(n).padStart(6, "0");

/** A lowercase RFC 4122 version 4 UUID from 128 seeded bits. */
export function syntheticUuid(next: () => bigint): string {
  const hi = (next() & ~(0xfn << 12n)) | (0x4n << 12n); // version 4
  const lo = (next() & ~(0x3n << 62n)) | (0x2n << 62n); // RFC 4122 variant
  const s = hex64(hi) + hex64(lo);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function rawShares(profile: SyntheticShareProfile, next: () => bigint): bigint {
  const r = next();
  if (profile === "uniform") return (r % 1_000_000n) + 1n;
  if (profile === "skewed") {
    const magnitude = next() % 49n; // 0 … 48 bits
    return (r & ((1n << magnitude) - 1n)) + 1n;
  }
  switch (r % 4n) {
    case 0n:
      return 1n;
    case 1n:
      return U64_MAX - (next() % 1000n);
    case 2n:
      return U64_MAX;
    default:
      return (next() % U64_MAX) + 1n;
  }
}

/** Generates a canonical synthetic snapshot input. Same parameters, same output. */
export function generateSyntheticOwnership(params: SyntheticOwnershipParams): OwnershipSnapshotInput {
  try {
    assertExactKeys("synthetic ownership params", params, ["seed", "holders", "profile", "withheldEvery", "unattributed", "assetId", "networkId", "reference"]);
  } catch (e) {
    throw new OwnershipSnapshotError("invalid_snapshot", (e as Error).message);
  }
  if (!(SIMULATION_NETWORK_IDS as readonly unknown[]).includes(params.networkId))
    throw new OwnershipSnapshotError("real_network", `synthetic datasets name simulation networks only (${SIMULATION_NETWORK_IDS.join(", ")}), not ${String(params.networkId)}`);
  if (typeof params.seed !== "bigint" || params.seed < 0n || params.seed > U64_MAX) throw new OwnershipSnapshotError("invalid_snapshot", "seed must be a u64 bigint");
  if (!(Number.isSafeInteger(params.holders) && params.holders >= 0 && params.holders <= SYNTHETIC_MAX_HOLDERS)) throw new OwnershipSnapshotError("invalid_snapshot", `holders must be an integer between 0 and ${SYNTHETIC_MAX_HOLDERS}`);
  if (!(Number.isSafeInteger(params.unattributed) && params.unattributed >= 0 && params.unattributed <= SYNTHETIC_MAX_HOLDERS)) throw new OwnershipSnapshotError("invalid_snapshot", `unattributed must be an integer between 0 and ${SYNTHETIC_MAX_HOLDERS}`);
  if (!(Number.isSafeInteger(params.withheldEvery) && params.withheldEvery >= 0)) throw new OwnershipSnapshotError("invalid_snapshot", "withheldEvery must be a non-negative integer");
  if (!(SYNTHETIC_SHARE_PROFILES as readonly unknown[]).includes(params.profile)) throw new OwnershipSnapshotError("invalid_snapshot", `profile must be one of ${SYNTHETIC_SHARE_PROFILES.join(", ")}`);

  const next = splitMix64(params.seed);
  const snapshotId = syntheticUuid(next);
  const entries: OwnershipSnapshotInput["entries"] = [];
  for (let i = 1; i <= params.holders; i++) {
    const withheld = params.withheldEvery > 0 && i % params.withheldEvery === 0;
    const tail = hex64(next()) + hex64(next()) + hex64(next()) + hex64(next()).slice(0, 8); // 28 bytes
    const payoutAddress = withheld ? null : i.toString(16).padStart(8, "0") + tail;
    entries.push({ partyId: `holder-${pad6(i)}`, payoutAddress, rawShares: rawShares(params.profile, next) });
  }
  const unattributed: OwnershipSnapshotInput["unattributed"] = [];
  for (let i = 1; i <= params.unattributed; i++) unattributed.push({ holderKey: `unattributed-${pad6(i)}`, rawShares: rawShares(params.profile, next) });
  return { snapshotId, assetId: params.assetId, networkId: params.networkId, reference: { ...params.reference }, entries, unattributed };
}
