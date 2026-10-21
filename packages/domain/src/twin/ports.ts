/**
 * Ports between the digital twin and the chain: reading ownership, and submitting transactions.
 * Adapters live in `packages/chain` (a fixture ledger for tests, a DAS reader for compressed NFTs,
 * and a submitter that is always disabled in this release). Nothing here imports a blockchain SDK.
 *
 * Transaction preparation is `previewTransfer` (./transfer): it is pure and never signs.
 */
import type { ChainAssetRef, OwnershipEvent } from "./ownership";

/**
 * How much of an ownership reading the platform itself checked:
 * - `inclusion_verified`: the indexer's proof for the leaf hashes to a root the on-chain tree still
 *   accepts (compressed NFTs). The binding of the reported owner to that leaf is not recomputed.
 * - `indexer_reported`: as reported by an indexer, nothing re-checked.
 * - `fixture`: test data; never shown as chain state.
 */
export const OWNERSHIP_ASSURANCES = ["inclusion_verified", "indexer_reported", "fixture"] as const;
export type OwnershipAssurance = (typeof OWNERSHIP_ASSURANCES)[number];

export interface OwnershipReading {
  holders: { owner: string; amount: bigint }[];
  /** Slot the reading reflects, when the source says. */
  asOfSlot: bigint | null;
  assurance: OwnershipAssurance;
}

/** Reads who holds an asset on chain. Returns null when this reader does not cover the asset. */
export interface OwnershipReader {
  readonly source: "chain_index" | "das" | "fixture";
  holdersOf(asset: ChainAssetRef): Promise<OwnershipReading | null>;
}

/**
 * Where an ownership indexer reads finalized ownership events from. `eventsAfter` returns the asset's
 * events with a slot after `afterSlot` (all of them when null) and the finalized slot through which that
 * list is complete; the indexer stores the events and only then moves its cursor to `throughSlot`.
 * Adapters live in `packages/chain`: a fixture source, and a Token-2022 source that reads finalized
 * transactions (read-only). Compressed NFTs have no event source yet.
 */
export interface OwnershipEventSource {
  readonly name: "fixture" | "rpc";
  /** Whether this source can answer for the asset (its rail and network). */
  covers(asset: ChainAssetRef): boolean;
  eventsAfter(asset: ChainAssetRef, afterSlot: bigint | null): Promise<{ events: OwnershipEvent[]; throughSlot: bigint }>;
}

/** Why transactions cannot be submitted. A submitter never guesses: any missing piece disables it. */
export const SUBMISSION_UNAVAILABLE_REASONS = ["not_enabled", "no_signer", "mainnet_blocked", "not_implemented"] as const;
export type SubmissionUnavailableReason = (typeof SUBMISSION_UNAVAILABLE_REASONS)[number];

export class SubmissionDisabledError extends Error {
  constructor(readonly reason: SubmissionUnavailableReason) {
    super(`transaction submission is unavailable: ${reason}`);
    this.name = "SubmissionDisabledError";
  }
}

/** Sends a transaction signed by the user's wallet. */
export interface TransactionSubmitter {
  readonly available: boolean;
  /** Present whenever `available` is false. */
  readonly reason?: SubmissionUnavailableReason;
  /** Throws `SubmissionDisabledError` when unavailable. */
  submit(signedWireBase64: string): Promise<{ txRef: string }>;
}
