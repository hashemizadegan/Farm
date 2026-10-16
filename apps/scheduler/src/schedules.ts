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
  return schedules;
}
