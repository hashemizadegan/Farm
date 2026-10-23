/**
 * Realtime outbox retention (migration 0030; horizons 0032). Scheduled by REALTIME_RETENTION_CRON (scheduler).
 *
 * One run deletes expired rows (expires_at in the past) in statements of `batchSize`, at most `maxBatches` statements
 * and within `maxMs`, then stops; what is left goes to the next run. Each statement also raises the affected
 * workspaces' retention horizon, which the realtime channel uses to answer a stale replay cursor with `resync`.
 * Safe to overlap, retry or restart: rows another run is deleting are skipped (SKIP LOCKED) and a deleted row is gone.
 */
import { pruneRealtimeEvents, withSystem, type Pool } from "@metafarm/db";
import type { RealtimeRetentionJob } from "@metafarm/domain";
import type { Handler } from "../runner";

export interface RealtimeRetentionOptions {
  batchSize: number;
  maxBatches: number;
  maxMs: number;
  now?: () => number;
}

export interface RealtimeRetentionOutcome {
  deleted: number;
  batches: number;
  workspaces: number;
  /** False when the run stopped at its batch or time budget with expired rows possibly left. */
  complete: boolean;
  ms: number;
}

export async function pruneRealtimeOutbox(pool: Pool, opts: RealtimeRetentionOptions): Promise<RealtimeRetentionOutcome> {
  const now = opts.now ?? Date.now;
  const started = now();
  let deleted = 0;
  let batches = 0;
  let workspaces = 0;
  let complete = false;
  while (batches < opts.maxBatches && now() - started < opts.maxMs) {
    const r = await withSystem(pool, (tx) => pruneRealtimeEvents(tx, opts.batchSize));
    batches++;
    deleted += r.deleted;
    workspaces += r.workspaces;
    if (r.deleted < opts.batchSize) {
      complete = true;
      break;
    }
  }
  return { deleted, batches, workspaces, complete, ms: now() - started };
}

export function realtimeRetentionHandler(pool: Pool, opts: RealtimeRetentionOptions): Handler<RealtimeRetentionJob> {
  return async (_job, { log }) => {
    const out = await pruneRealtimeOutbox(pool, opts);
    // Counts only: no event content is logged.
    if (out.complete) log.info(out, "realtime retention run");
    else log.warn(out, "realtime retention run stopped at its budget; expired rows remain for the next run");
    return out;
  };
}
