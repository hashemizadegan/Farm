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
 * Read-only on chain: nothing is signed or submitted. Holdings are not written; readers rebuild them.
 */
import { advanceOwnershipCursor, insertOwnershipEvents, ownershipCursorOf, ownershipIndexTargets, withSystem, type Pool } from "@metafarm/db";
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

export function ownershipIndexHandler(pool: Pool, source: OwnershipEventSource): Handler<OwnershipIndexJob> {
  return async (job, { log }): Promise<OwnershipIndexOutcome> => {
    const asset: ChainAssetRef = { network: job.network, rail: job.rail, id: job.assetId };
    if (!source.covers(asset)) return { status: "skipped", reason: "not_covered" };
    const cursor = await withSystem(pool, (tx) => ownershipCursorOf(tx, asset));
    const { events, throughSlot } = await source.eventsAfter(asset, cursor);
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
      const inserted = await insertOwnershipEvents(tx, events, source.name);
      const through = await advanceOwnershipCursor(tx, asset, throughSlot, source.name);
      return { inserted, through };
    });
    log.info({ asset: job.assetId, inserted: result.inserted, through: result.through.toString() }, "ownership indexed");
    return { status: "indexed", inserted: result.inserted, indexedThroughSlot: result.through.toString() };
  };
}
