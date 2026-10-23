import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { loadEnv, schedulerEnvSchema } from "@metafarm/config";
import { createLogger, installGracefulShutdown, startHealthServer } from "@metafarm/observability";
import { QUEUES } from "@metafarm/domain";
import { buildSchedules } from "./schedules";

// On Railway the platform assigns PORT; the health server uses it unless HEALTH_PORT is set.
const env = loadEnv(schedulerEnvSchema, { ...process.env, HEALTH_PORT: process.env.HEALTH_PORT ?? process.env.PORT });
const logger = createLogger({ service: env.SERVICE_NAME ?? "scheduler", level: env.LOG_LEVEL, environment: env.APP_ENV, pretty: env.APP_ENV === "development" });
const shutdown = installGracefulShutdown(logger, env.SHUTDOWN_GRACE_MS);
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, family: 0 });

// Contracts to index: "0xaddr@fromBlock,0xaddr2@fromBlock".
const contracts = env.CHAIN_INDEX_CONTRACTS.map((entry) => {
  const [address, fromBlock = "0"] = entry.split("@");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address!) || !/^\d+$/.test(fromBlock)) throw new Error(`invalid CHAIN_INDEX_CONTRACTS entry: ${entry}`);
  return { address: address!, fromBlock };
});

const schedules = buildSchedules({
  alertCron: env.ALERT_EVALUATION_CRON,
  chainCron: env.CHAIN_INDEX_CRON,
  chainId: env.CHAIN_ID,
  contracts,
  twinSnapshotCron: env.TWIN_SNAPSHOT_CRON,
  twinSnapshotBatchCron: env.TWIN_SNAPSHOT_BATCH_CRON,
  ownershipIndexCron: env.TWIN_OWNERSHIP_INDEX_CRON,
  realtimeRetentionCron: env.REALTIME_RETENTION_CRON,
});

const queues = new Map<string, Queue>();
for (const s of schedules) {
  let q = queues.get(s.queue);
  if (!q) queues.set(s.queue, (q = new Queue(s.queue, { connection, prefix: env.QUEUE_PREFIX })));
  // Idempotent: upserting the same scheduler id updates it in place.
  await q.upsertJobScheduler(
    s.id,
    { pattern: s.pattern, tz: env.SCHEDULER_TZ },
    {
      name: s.jobName,
      data: s.data,
      opts: { attempts: 3, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: { count: 1_000 }, removeOnFail: { age: 7 * 86_400 } },
    },
  );
  logger.info({ scheduler: s.id, queue: s.queue, pattern: s.pattern }, "schedule upserted");
}

// The twin sweeps and realtime retention are opt-in: when a cron is unset, make sure no earlier schedule lingers.
for (const [cron, queue, id, setting] of [
  [env.TWIN_SNAPSHOT_CRON, QUEUES.twinSnapshots, "twin-snapshots-sweep", "TWIN_SNAPSHOT_CRON"],
  [env.TWIN_SNAPSHOT_BATCH_CRON, QUEUES.twinSnapshotBatches, "twin-snapshot-batches-sweep", "TWIN_SNAPSHOT_BATCH_CRON"],
  [env.TWIN_OWNERSHIP_INDEX_CRON, QUEUES.ownershipIndex, "ownership-index-sweep", "TWIN_OWNERSHIP_INDEX_CRON"],
  [env.REALTIME_RETENTION_CRON, QUEUES.realtimeRetention, "realtime-retention", "REALTIME_RETENTION_CRON"],
] as const) {
  if (cron) continue;
  const q = queues.get(queue) ?? new Queue(queue, { connection, prefix: env.QUEUE_PREFIX });
  queues.set(queue, q);
  if (await q.removeJobScheduler(id)) logger.info({ scheduler: id }, `schedule removed (${setting} unset)`);
}

const health = startHealthServer({
  port: env.HEALTH_PORT,
  isDraining: () => shutdown.isShuttingDown,
  checks: [{ name: "redis", check: async () => (await connection.ping()) === "PONG" }],
});

shutdown.register({ name: "redis", close: async () => void (await connection.quit()) });
shutdown.register({ name: "queues", close: async () => void (await Promise.all([...queues.values()].map((q) => q.close()))) });
shutdown.register({ name: "health", close: () => new Promise<void>((r) => health.close(() => r())) });

logger.info({ schedules: schedules.length }, "scheduler running");
