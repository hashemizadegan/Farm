import { Queue, Worker, type Processor } from "bullmq";
import { Redis } from "ioredis";
import { loadEnv, workerEnvSchema } from "@metafarm/config";
import { claimJobRun, completeJobRun, createPool, failJobRun, pingDatabase } from "@metafarm/db";
import { QUEUES, idempotencyKey, jobIdFromKey, timeBucket, type JobPayloads } from "@metafarm/domain";
import { createLogger, installGracefulShutdown, startHealthServer } from "@metafarm/observability";
import { createViemChainReader } from "./chain-reader";
import { alertEvaluationHandler, alertSweepHandler, pendingBoundarySweepHandler } from "./handlers/alerts";
import { chainIndexHandler } from "./handlers/chain";
import { gisValidationHandler } from "./handlers/gis";
import { dbAnchorStore, harvestAnchorHandler } from "./handlers/harvest";
import { createHarvestRegistryClient } from "./harvest-registry";
import { imageryIngestionHandler, noImageryProvider } from "./handlers/imagery";
import { observationNormalizationHandler } from "./handlers/observations";
import { wrapHandler, type DeadLetterSink, type JobRunStore } from "./runner";

// On Railway the platform assigns PORT; the health server uses it unless HEALTH_PORT is set.
const env = loadEnv(workerEnvSchema, { ...process.env, HEALTH_PORT: process.env.HEALTH_PORT ?? process.env.PORT });
const logger = createLogger({ service: env.SERVICE_NAME ?? "worker", level: env.LOG_LEVEL, environment: env.APP_ENV, pretty: env.APP_ENV === "development" });
const shutdown = installGracefulShutdown(logger, env.SHUTDOWN_GRACE_MS);

const pool = createPool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX, ssl: env.DATABASE_SSL, applicationName: "metafarm-worker" });
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, family: 0 });
const prefix = env.QUEUE_PREFIX;

const store: JobRunStore = {
  claim: (key, queue) => claimJobRun(pool, key, queue),
  complete: (key, result) => completeJobRun(pool, key, result),
  fail: (key, error, dead) => failJobRun(pool, key, error, dead),
};

const deadLetterQueue = new Queue(QUEUES.deadLetter, { connection, prefix });
const deadLetter: DeadLetterSink = {
  async send(entry) {
    // Dead-lettered jobs are kept for inspection and manual replay; they are never retried automatically.
    await deadLetterQueue.add("dead", entry, { removeOnComplete: false, removeOnFail: false });
  },
};

const producers = new Map<string, Queue>();
async function enqueue<Q extends keyof JobPayloads>(queue: Q, payload: JobPayloads[Q]) {
  let q = producers.get(queue);
  if (!q) producers.set(queue, (q = new Queue(queue, { connection, prefix })));
  const key = idempotencyKey(queue, payload);
  await q.add(queue, { ...payload, idempotencyKey: key }, {
    jobId: jobIdFromKey(key),
    attempts: env.JOB_MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: env.JOB_BACKOFF_BASE_MS },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 7 * 86_400 },
  });
}

const deps = { store, deadLetter, logger };
const chainReader = env.CHAIN_RPC_URL ? createViemChainReader(env.CHAIN_RPC_URL) : undefined;

const harvestRegistry =
  env.CHAIN_RPC_URL && env.HARVEST_REGISTRY_ADDRESS && env.CHAIN_SIGNER_PRIVATE_KEY
    ? createHarvestRegistryClient({
        rpcUrl: env.CHAIN_RPC_URL,
        chainId: env.CHAIN_ID,
        chainName: env.CHAIN_NAME,
        address: env.HARVEST_REGISTRY_ADDRESS,
        privateKey: env.CHAIN_SIGNER_PRIVATE_KEY as `0x${string}`,
        confirmations: env.CHAIN_CONFIRMATIONS,
        timeoutSeconds: env.CHAIN_TX_TIMEOUT_SECONDS,
      })
    : undefined;
if (!harvestRegistry) logger.info("harvest registry not configured; batches stay unregistered");

const processors: Record<string, Processor> = {
  [QUEUES.anchor]: wrapHandler(QUEUES.anchor, harvestAnchorHandler(dbAnchorStore(pool), harvestRegistry, { maxAttempts: env.JOB_MAX_ATTEMPTS }), deps) as Processor,
  [QUEUES.gis]: wrapHandler(QUEUES.gis, gisValidationHandler(pool), deps) as Processor,
  [QUEUES.imagery]: wrapHandler(QUEUES.imagery, imageryIngestionHandler(pool, noImageryProvider), deps) as Processor,
  [QUEUES.observations]: wrapHandler(QUEUES.observations, observationNormalizationHandler(pool), deps) as Processor,
  [QUEUES.alerts]: (async (job) => {
    // The alerts queue carries both scheduled sweeps and per-farm evaluations.
    if (job.name === "sweep") {
      const bucket: string = job.data.bucket ?? timeBucket(new Date());
      // Pass an explicit view of the job: spreading a BullMQ Job would drop its prototype methods.
      const view = (key: string) => ({
        id: job.id,
        name: job.name,
        attemptsMade: job.attemptsMade,
        opts: job.opts,
        discard: () => job.discard(),
        data: { bucket, idempotencyKey: key },
      });
      await wrapHandler("alerts-sweep", alertSweepHandler(pool, enqueue), deps)(view(`alerts-sweep:${bucket}`));
      return wrapHandler("boundary-sweep", pendingBoundarySweepHandler(pool, enqueue), deps)(view(`boundary-sweep:${bucket}`));
    }
    return wrapHandler(QUEUES.alerts, alertEvaluationHandler(pool), deps)(job);
  }) as Processor,
  [QUEUES.chain]: (async (job) => {
    if (!chainReader) {
      logger.warn("CHAIN_RPC_URL not set; skipping chain indexing");
      return { skipped: true };
    }
    // Scheduled runs carry no upper bound; each scheduler iteration has a unique job id,
    // so "latest:<jobId>" gives every run its own idempotency key.
    const data = { ...job.data, toBlock: job.data.toBlock ?? `latest:${job.id}` };
    const view = {
      id: job.id,
      name: job.name,
      attemptsMade: job.attemptsMade,
      opts: job.opts,
      discard: () => job.discard(),
      data: { ...data, idempotencyKey: job.data.idempotencyKey ?? idempotencyKey(QUEUES.chain, data) },
    };
    return wrapHandler(
      QUEUES.chain,
      chainIndexHandler(pool, chainReader, { chainId: env.CHAIN_ID, confirmations: env.CHAIN_CONFIRMATIONS, maxRange: 2_000n, reorgRewind: 64n }),
      deps,
    )(view);
  }) as Processor,
};

const workers = Object.entries(processors).map(([name, processor]) => {
  const w = new Worker(name, processor, {
    connection,
    prefix,
    concurrency: env.WORKER_CONCURRENCY,
    // Lock renewal keeps long jobs from being picked up twice while still running.
    lockDuration: 60_000,
    maxStalledCount: 2,
  });
  w.on("failed", (job, err) => logger.warn({ queue: name, jobId: job?.id, err: err.message }, "job attempt failed"));
  w.on("error", (err) => logger.error({ queue: name, err }, "worker error"));
  return w;
});

const health = startHealthServer({
  port: env.HEALTH_PORT,
  isDraining: () => shutdown.isShuttingDown,
  checks: [
    { name: "database", check: () => pingDatabase(pool) },
    { name: "redis", check: async () => (await connection.ping()) === "PONG" },
  ],
});

shutdown.register({ name: "postgres", close: () => pool.end() });
shutdown.register({ name: "redis", close: async () => void (await connection.quit()) });
shutdown.register({ name: "producers", close: async () => void (await Promise.all([...producers.values(), deadLetterQueue].map((q) => q.close()))) });
// Workers close first: stop taking new jobs and wait for in-flight ones to finish.
shutdown.register({ name: "workers", close: async () => void (await Promise.all(workers.map((w) => w.close()))) });
shutdown.register({ name: "health", close: () => new Promise<void>((r) => health.close(() => r())) });

logger.info({ queues: Object.keys(processors), concurrency: env.WORKER_CONCURRENCY }, "worker started");
