/**
 * Ownership index jobs (digital twin, J7). Off unless TWIN_OWNERSHIP_INDEX_ENABLED is set on the worker,
 * TWIN_OWNERSHIP_INDEX_CRON on the scheduler, and an event source is configured.
 *
 * - The sweep lists every Solana asset the platform has a chain identity for and enqueues one job per
 *   asset, keyed by asset and bucket.
 * - The asset job asks the source for the asset's finalized events after the stored cursor, checks that
 *   they belong to the asset and lie inside the window, and in one system transaction stores them and
 *   moves the cursor to the slot the source says they are complete through. The cursor never moves back.
 *
 * Cluster identity (Y0, D-16 option A): an RPC source comes with an identity guard. Before each batch the
 * job verifies the endpoint's cluster (getGenesisHash), reads the events, and verifies again; both answers
 * must be the same identity, for the job's network. Only then, in one system transaction, it records the
 * identity (or marks it verified again) and stores the events and the cursor bound to it. Any failure writes
 * nothing and leaves the cursor where it was, with a stable structured error (OwnershipSourceIdentityError).
 * Fixture sources carry no identity and stay simulation-only.
 *
 * Read-only on chain: nothing is signed or submitted. Holdings are not written; readers rebuild them.
 */
import { ClusterVerificationError, type VerifiedClusterIdentity } from "@metafarm/chain";
import { advanceOwnershipCursor, insertOwnershipEvents, ownershipCursorOf, ownershipIndexTargets, registerOwnershipSourceIdentity, withSystem, type OwnershipSourceIdentity, type Pool } from "@metafarm/db";
import { QUEUES, type ChainAssetRef, type OwnershipEventSource, type OwnershipIndexJob } from "@metafarm/domain";
import type { Handler } from "../runner";
import type { Enqueue } from "./alerts";

export function ownershipIndexSweepHandler(pool: Pool, enqueue: Enqueue): Handler<{ bucket: string }> {
  return async (job, { log }) => {
    const targets = await withSystem(pool, (tx) => ownershipIndexTargets(tx));
    for (const a of targets)
      await enqueue(QUEUES.ownershipIndex, { network: a.network as OwnershipIndexJob["network"], rail: a.rail as OwnershipIndexJob["rail"], assetId: a.id, bucket: job.bucket });
    log.info({ assets: targets.length }, "ownership index sweep fanned out");
    return { assets: targets.length };
  };
}

export type OwnershipIndexOutcome =
  | { status: "indexed"; inserted: number; indexedThroughSlot: string }
  | { status: "skipped"; reason: "source_behind_cursor" | "not_covered" };

export class OwnershipSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipSourceError";
  }
}

/** Verifies the RPC endpoint's cluster on demand (a fresh getGenesisHash each call). */
export interface SourceIdentityGuard {
  /** Recorded as `verified_by`, e.g. "worker:ownership-index". */
  readonly verifiedBy: string;
  /** Resolves with the verified identity; throws ClusterVerificationError otherwise. */
  verify(): Promise<VerifiedClusterIdentity>;
}

export const OWNERSHIP_IDENTITY_ERROR_CODES = ["identity_not_configured", "cluster_mismatch", "cluster_unavailable", "cluster_invalid_response", "network_mismatch", "identity_changed"] as const;
export type OwnershipIdentityErrorCode = (typeof OWNERSHIP_IDENTITY_ERROR_CODES)[number];

/** Why an ownership batch was refused for its cluster identity. Stable code and fields; no credentials. */
export class OwnershipSourceIdentityError extends Error {
  constructor(
    readonly code: OwnershipIdentityErrorCode,
    readonly details: { network: string; endpoint: string | null; expectedGenesisHash: string | null; actualGenesisHash: string | null },
    message: string,
  ) {
    super(message);
    this.name = "OwnershipSourceIdentityError";
  }
}

const sameIdentity = (a: VerifiedClusterIdentity, b: VerifiedClusterIdentity) =>
  a.network === b.network && a.genesisHash === b.genesisHash && a.endpointScheme === b.endpointScheme && a.endpointHost === b.endpointHost;

/** Runs the guard for a network, turning every failure into an OwnershipSourceIdentityError. */
async function verifiedFor(guard: SourceIdentityGuard, network: string): Promise<VerifiedClusterIdentity> {
  let id: VerifiedClusterIdentity;
  try {
    id = await guard.verify();
  } catch (err) {
    if (err instanceof ClusterVerificationError) {
      const code = err.reason === "mismatch" ? "cluster_mismatch" : err.reason === "unavailable" ? "cluster_unavailable" : "cluster_invalid_response";
      throw new OwnershipSourceIdentityError(code, { network, endpoint: err.endpoint, expectedGenesisHash: err.expectedGenesisHash, actualGenesisHash: err.actualGenesisHash }, err.message);
    }
    throw err;
  }
  if (id.network !== network)
    throw new OwnershipSourceIdentityError("network_mismatch", { network, endpoint: `${id.endpointScheme}://${id.endpointHost}`, expectedGenesisHash: null, actualGenesisHash: id.genesisHash }, `the source is verified for ${id.network}, not ${network}`);
  return id;
}

/**
 * Registration: verifies the source's cluster and records the identity (or marks it verified again).
 * Called when the worker starts; every batch verifies again before writing.
 */
export async function registerOwnershipSource(pool: Pool, guard: SourceIdentityGuard, network: string): Promise<OwnershipSourceIdentity> {
  const id = await verifiedFor(guard, network);
  return withSystem(pool, (tx) => registerOwnershipSourceIdentity(tx, { ...id, verifiedBy: guard.verifiedBy }));
}

export function ownershipIndexHandler(pool: Pool, source: OwnershipEventSource, guard?: SourceIdentityGuard): Handler<OwnershipIndexJob> {
  return async (job, { log }): Promise<OwnershipIndexOutcome> => {
    const asset: ChainAssetRef = { network: job.network, rail: job.rail, id: job.assetId };
    if (!source.covers(asset)) return { status: "skipped", reason: "not_covered" };
    const refuse = (e: OwnershipSourceIdentityError): never => {
      log.error({ asset: job.assetId, code: e.code, ...e.details }, "ownership batch refused: cluster identity");
      throw e;
    };
    // RPC data is indexed only from a verified cluster: no guard, no batch.
    if (source.name === "rpc" && !guard)
      refuse(new OwnershipSourceIdentityError("identity_not_configured", { network: job.network, endpoint: null, expectedGenesisHash: null, actualGenesisHash: null }, "an RPC ownership source needs a cluster identity guard"));
    const verify = async () => {
      try {
        return await verifiedFor(guard!, job.network);
      } catch (e) {
        if (e instanceof OwnershipSourceIdentityError) refuse(e);
        throw e;
      }
    };
    const before = source.name === "rpc" ? await verify() : null;
    const cursor = await withSystem(pool, (tx) => ownershipCursorOf(tx, asset));
    const { events, throughSlot } = await source.eventsAfter(asset, cursor);
    // Verified again after reading: the events were fetched between two answers from the same cluster.
    const identity = before ? await verify() : null;
    if (before && identity && !sameIdentity(before, identity))
      refuse(new OwnershipSourceIdentityError("identity_changed", { network: job.network, endpoint: `${identity.endpointScheme}://${identity.endpointHost}`, expectedGenesisHash: before.genesisHash, actualGenesisHash: identity.genesisHash }, "the source's cluster identity changed during the batch"));
    if (cursor !== null && throughSlot < cursor) {
      log.warn({ asset: job.assetId, cursor: cursor.toString(), throughSlot: throughSlot.toString() }, "ownership source is behind the index; nothing recorded");
      return { status: "skipped", reason: "source_behind_cursor" };
    }
    // A source must answer for this asset and this window only; anything else is refused, not stored.
    for (const e of events) {
      const same = e.asset.network === asset.network && e.asset.rail === asset.rail && e.asset.id === asset.id;
      if (!same) throw new OwnershipSourceError(`the source returned an event of another asset (${e.asset.id})`);
      if (e.slot > throughSlot || (cursor !== null && e.slot <= cursor)) throw new OwnershipSourceError(`the source returned an event at slot ${e.slot} outside (${cursor ?? "start"}, ${throughSlot}]`);
    }
    const result = await withSystem(pool, async (tx) => {
      const identityId = identity ? (await registerOwnershipSourceIdentity(tx, { ...identity, verifiedBy: guard!.verifiedBy })).id : null;
      const inserted = await insertOwnershipEvents(tx, events, source.name, identityId);
      const through = await advanceOwnershipCursor(tx, asset, throughSlot, source.name, identityId);
      return { inserted, through, identityId };
    });
    log.info({ asset: job.assetId, inserted: result.inserted, through: result.through.toString(), sourceIdentityId: result.identityId?.toString() ?? null }, "ownership indexed");
    return { status: "indexed", inserted: result.inserted, indexedThroughSlot: result.through.toString() };
  };
}
