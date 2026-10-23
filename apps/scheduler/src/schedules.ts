import { QUEUES } from "@metafarm/domain";

export interface ScheduleDefinition {
  /** Stable id; upserting the same id replaces the schedule instead of duplicating it. */
  id: string;
  queue: string;
  jobName: string;
  pattern: string;
  data: Record<string, unknown>;
}

export interface ScheduleConfig {
  alertCron: string;
  chainCron: string;
  chainId: number;
  contracts: { address: string; fromBlock: string }[];
  /** Digital-twin snapshot sweep; no schedule when unset. */
  twinSnapshotCron?: string;
  /** Digital-twin batching of snapshot commitments; no schedule when unset. */
  twinSnapshotBatchCron?: string;
  /** Digital-twin ownership index sweep; no schedule when unset. */
  ownershipIndexCron?: string;
  /** Realtime outbox retention; no schedule when unset. */
  realtimeRetentionCron?: string;
}

/**
 * Pure schedule definitions. The scheduler process upserts these into BullMQ
 * job schedulers, which are stored in Redis and therefore survive restarts
 * and are not duplicated when more than one scheduler instance runs.
 *
 * Imagery ingestion is intentionally not scheduled until an imagery provider
 * is configured (see apps/worker/src/handlers/imagery.ts).
 */
export function buildSchedules(cfg: ScheduleConfig): ScheduleDefinition[] {
  const schedules: ScheduleDefinition[] = [
    { id: "alerts-sweep", queue: QUEUES.alerts, jobName: "sweep", pattern: cfg.alertCron, data: {} },
  ];
  for (const c of cfg.contracts) {
    schedules.push({
      id: `chain-index-${cfg.chainId}-${c.address.toLowerCase()}`,
      queue: QUEUES.chain,
      jobName: "index",
      pattern: cfg.chainCron,
      data: { chainId: cfg.chainId, contractAddress: c.address.toLowerCase(), fromBlock: c.fromBlock },
    });
  }
  if (cfg.twinSnapshotCron) {
    schedules.push({ id: "twin-snapshots-sweep", queue: QUEUES.twinSnapshots, jobName: "sweep", pattern: cfg.twinSnapshotCron, data: {} });
  }
  if (cfg.twinSnapshotBatchCron) {
    schedules.push({ id: "twin-snapshot-batches-sweep", queue: QUEUES.twinSnapshotBatches, jobName: "sweep", pattern: cfg.twinSnapshotBatchCron, data: {} });
  }
  if (cfg.ownershipIndexCron) {
    schedules.push({ id: "ownership-index-sweep", queue: QUEUES.ownershipIndex, jobName: "sweep", pattern: cfg.ownershipIndexCron, data: {} });
  }
  if (cfg.realtimeRetentionCron) {
    schedules.push({ id: "realtime-retention", queue: QUEUES.realtimeRetention, jobName: "prune", pattern: cfg.realtimeRetentionCron, data: {} });
  }
  return schedules;
}
