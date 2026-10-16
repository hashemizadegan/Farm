/**
 * Background job contracts shared by the API (producer), scheduler
 * (producer) and worker (consumer).
 *
 * Every job carries an idempotency key. The worker records completed keys in
 * `job_runs` and skips a job whose key has already completed, so a retried or
 * duplicated delivery has no extra effect.
 */

export const QUEUES = {
  gis: "gis-validation",
  imagery: "imagery-ingestion",
  observations: "observation-normalization",
  alerts: "alert-evaluation",
  chain: "chain-event-indexing",
  deadLetter: "dead-letter",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface GisValidationJob {
  tenantId: string;
  farmId: string;
  boundaryVersionId: string;
}

export interface ImageryIngestionJob {
  tenantId: string;
  farmId: string;
  /** Requested acquisition window; the provider decides what, if anything, exists. */
  from: string;
  to: string;
}

export interface ObservationNormalizationJob {
  tenantId: string;
  farmId: string;
  rawObservationId: string;
}

export interface AlertEvaluationJob {
  tenantId: string;
  farmId: string;
  /** Evaluation window bucket; makes scheduled runs idempotent per bucket. */
  bucket: string;
}

export interface ChainEventIndexingJob {
  chainId: number;
  contractAddress: string;
  fromBlock: string;
  toBlock: string;
}

export interface JobPayloads {
  [QUEUES.gis]: GisValidationJob;
  [QUEUES.imagery]: ImageryIngestionJob;
  [QUEUES.observations]: ObservationNormalizationJob;
  [QUEUES.alerts]: AlertEvaluationJob;
  [QUEUES.chain]: ChainEventIndexingJob;
}

export function idempotencyKey<Q extends keyof JobPayloads>(queue: Q, payload: JobPayloads[Q]): string {
  switch (queue) {
    case QUEUES.gis: {
      const p = payload as GisValidationJob;
      return `gis:${p.tenantId}:${p.boundaryVersionId}`;
    }
    case QUEUES.imagery: {
      const p = payload as ImageryIngestionJob;
      return `imagery:${p.tenantId}:${p.farmId}:${p.from}:${p.to}`;
    }
    case QUEUES.observations: {
      const p = payload as ObservationNormalizationJob;
      return `obs:${p.tenantId}:${p.rawObservationId}`;
    }
    case QUEUES.alerts: {
      const p = payload as AlertEvaluationJob;
      return `alerts:${p.tenantId}:${p.farmId}:${p.bucket}`;
    }
    case QUEUES.chain: {
      const p = payload as ChainEventIndexingJob;
      return `chain:${p.chainId}:${p.contractAddress.toLowerCase()}:${p.fromBlock}-${p.toBlock}`;
    }
    default:
      throw new Error(`unknown queue ${String(queue)}`);
  }
}

/** BullMQ job ids may not contain ':'; derive a safe id from the key. */
export function jobIdFromKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * Exponential backoff with full jitter, capped. `attempt` starts at 1.
 * Pass `random` for deterministic tests.
 */
export function backoffDelayMs(attempt: number, baseMs: number, capMs = 10 * 60_000, random = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * exp);
}

/** Errors the worker must not retry (bad input, permanent provider rejection). */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableJobError";
  }
}

/** Five-minute bucket label used for scheduled alert evaluation. */
export function timeBucket(d: Date, minutes = 5): string {
  const ms = minutes * 60_000;
  return new Date(Math.floor(d.getTime() / ms) * ms).toISOString();
}
