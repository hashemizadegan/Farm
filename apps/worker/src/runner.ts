import type { Job } from "bullmq";
import { NonRetryableJobError } from "@metafarm/domain";
import type { JobMetrics, Logger } from "@metafarm/observability";

/**
 * Persistence for job idempotency. Backed by the job_runs table in production
 * and by a Map in unit tests.
 */
export interface JobRunStore {
  claim(key: string, queue: string): Promise<"claimed" | "completed">;
  complete(key: string, result: unknown): Promise<void>;
  fail(key: string, error: string, deadLettered: boolean): Promise<void>;
}

export interface DeadLetterSink {
  send(entry: { queue: string; jobId: string | undefined; name: string; data: unknown; error: string; attempts: number }): Promise<void>;
}

export type Handler<T> = (data: T, ctx: { log: Logger; attempt: number; jobId: string | undefined }) => Promise<unknown>;

export interface RunnerDeps {
  store: JobRunStore;
  deadLetter: DeadLetterSink;
  logger: Logger;
  /** Job outcomes and durations per queue (metafarm_jobs_total, metafarm_job_duration_seconds). */
  metrics?: JobMetrics;
}

/**
 * Wraps a handler with:
 *  - idempotency: skip if this key already completed,
 *  - structured logs with queue, job id, key and attempt,
 *  - non-retryable errors: fail immediately (job.discard) and dead-letter,
 *  - final-attempt failures: dead-letter with the error.
 * Retries and exponential backoff are configured on the job (attempts/backoff).
 */
// No constraint on T: job payload interfaces share no keys with { idempotencyKey?: string },
// and TypeScript's weak-type check would reject them. The key is added at the job level instead.
export function wrapHandler<T>(queue: string, handler: Handler<T>, deps: RunnerDeps) {
  return async (job: Pick<Job<T & { idempotencyKey?: string }>, "id" | "name" | "data" | "attemptsMade" | "opts" | "discard">) => {
    const key = job.data.idempotencyKey ?? `${queue}:${job.id}`;
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const log = deps.logger.child({ queue, jobId: job.id, jobName: job.name, key, attempt });

    const state = await deps.store.claim(key, queue);
    if (state === "completed") {
      log.info("job already completed; skipping");
      deps.metrics?.jobs.inc({ queue, outcome: "skipped" });
      return { skipped: true };
    }

    const started = Date.now();
    try {
      const result = await handler(job.data, { log, attempt, jobId: job.id });
      await deps.store.complete(key, result);
      log.info({ durationMs: Date.now() - started }, "job completed");
      deps.metrics?.jobs.inc({ queue, outcome: "completed" });
      deps.metrics?.duration.observe({ queue }, (Date.now() - started) / 1000);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof NonRetryableJobError;
      const last = permanent || attempt >= maxAttempts;
      log.error({ err, durationMs: Date.now() - started, permanent, last }, "job failed");
      deps.metrics?.jobs.inc({ queue, outcome: "failed" });
      deps.metrics?.duration.observe({ queue }, (Date.now() - started) / 1000);
      if (last) deps.metrics?.jobs.inc({ queue, outcome: "dead_lettered" });
      if (permanent) job.discard();
      await deps.store.fail(key, message, last);
      if (last) {
        await deps.deadLetter.send({ queue, jobId: job.id, name: job.name, data: job.data, error: message, attempts: attempt });
      }
      throw err;
    }
  };
}
