import { Queue, Worker, type Processor } from "bullmq";
import { Redis } from "ioredis";
import { loadEnv, workerEnvSchema } from "@metafarm/config";
import { bubblegumTreeOf, claimJobRun, completeJobRun, createPool, failJobRun, pingDatabase, withSystem } from "@metafarm/db";
import { QUEUES, idempotencyKey, jobIdFromKey, timeBucket, type JobPayloads } from "@metafarm/domain";
import { MetricsRegistry, QUEUE_STATES, createJobMetrics, createLogger, createQueueDepthGauge, installGracefulShutdown, startHealthServer } from "@metafarm/observability";
import { createViemChainReader } from "./chain-reader";
import { alertEvaluationHandler, alertSweepHandler, maintenanceDueSweepHandler, pendingBoundarySweepHandler, sensorSilenceSweepHandler } from "./handlers/alerts";
import { chainIndexHandler } from "./handlers/chain";
import { gisValidationHandler } from "./handlers/gis";
import { dbAnchorStore, harvestAnchorHandler } from "./handlers/harvest";
import { createHarvestRegistryClient } from "./harvest-registry";
import { imageryIngestionHandler, noImageryProvider } from "./handlers/imagery";
import { observationNormalizationHandler } from "./handlers/observations";
import { rwaReconciliationSweepHandler } from "./handlers/rwa";
import { wrapHandler, type DeadLetterSink, type JobRunStore } from "./runner";
import { startTelemetryConsumer } from "./telemetry/consumer";
import { startRwaEngine } from "./rwa/start";
import { twinSnapshotHandler, twinSnapshotSweepHandler } from "./handlers/twin-snapshots";
import { twinSnapshotBatchHandler, twinSnapshotBatchSweepHandler } from "./handlers/twin-snapshot-batches";
import { ownershipIndexHandler, ownershipIndexSweepHandler, registerOwnershipSource, type SourceIdentityGuard } from "./handlers/ownership-index";
import type { OwnershipEventSource } from "@metafarm/domain";
import { combineOwnershipSources, createBubblegumOwnershipSource, createToken2022OwnershipSource, httpSolanaHistoryRpc, verifyClusterIdentity } from "@metafarm/chain";
import { createObjectContentStore, createStorageFromEnv } from "@metafarm/storage";

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

// Metrics are recorded always (in memory) and exposed on HEALTH_PORT only when METRICS_TOKEN is set.
const metricsRegistry = new MetricsRegistry();
const deps = { store, deadLetter, logger, metrics: createJobMetrics(metricsRegistry) };
// Where the ownership index reads finalized events from: Token-2022 and Bubblegum V1 transactions through the Solana RPC,
// read-only (the history client has no send method). Only when the index is enabled and an RPC URL is
// set, and on mainnet only with RWA_MAINNET_ENABLED; otherwise ownership-index jobs are skipped.
const ownershipEventSource: OwnershipEventSource | undefined =
  env.TWIN_OWNERSHIP_INDEX_ENABLED && env.RWA_SOLANA_RPC_URL && (env.RWA_SOLANA_NETWORK === "solana-devnet" || env.RWA_MAINNET_ENABLED)
    ? combineOwnershipSources(
        createToken2022OwnershipSource(httpSolanaHistoryRpc(env.RWA_SOLANA_RPC_URL), env.RWA_SOLANA_NETWORK),
        createBubblegumOwnershipSource(httpSolanaHistoryRpc(env.RWA_SOLANA_RPC_URL), env.RWA_SOLANA_NETWORK, (assetId) =>
          withSystem(pool, (tx) => bubblegumTreeOf(tx, env.RWA_SOLANA_NETWORK, assetId)),
        ),
      )
    : undefined;

// Y0: the RPC ownership source is bound to a verified cluster identity (getGenesisHash). Registered here,
// verified again before every batch; a source that cannot be verified indexes nothing.
const ownershipIdentityGuard: SourceIdentityGuard | undefined =
  ownershipEventSource && env.RWA_SOLANA_RPC_URL
    ? { verifiedBy: "worker:ownership-index", verify: () => verifyClusterIdentity({ url: env.RWA_SOLANA_RPC_URL!, network: env.RWA_SOLANA_NETWORK, label: "RPC" }) }
    : undefined;
if (ownershipIdentityGuard)
  await registerOwnershipSource(pool, ownershipIdentityGuard, env.RWA_SOLANA_NETWORK).then(
    (id) => logger.info({ sourceIdentityId: id.id.toString(), network: id.network, endpoint: `${id.endpointScheme}://${id.endpointHost}` }, "ownership source cluster identity registered"),
    (err: unknown) =>
      logger.error(
        { code: (err as { code?: string }).code ?? "unknown", ...((err as { details?: object }).details ?? {}), err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
        "ownership source cluster identity not verified; every batch will be refused until it is",
      ),
  );

// Object storage for twin snapshots, created only when they are enabled.
const twinObjectStorage = env.TWIN_SNAPSHOTS_ENABLED ? createStorageFromEnv(env) : undefined;
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
      await wrapHandler("sensor-silence", sensorSilenceSweepHandler(pool), deps)(view(`sensor-silence:${bucket}`));
      await wrapHandler("maintenance-due", maintenanceDueSweepHandler(pool), deps)(view(`maintenance-due:${bucket}`));
      await wrapHandler("rwa-reconciliation", rwaReconciliationSweepHandler(pool, env.RWA_RECONCILIATION_SLA_MINUTES), deps)(view(`rwa-reconciliation:${bucket}`));
      return wrapHandler("boundary-sweep", pendingBoundarySweepHandler(pool, enqueue), deps)(view(`boundary-sweep:${bucket}`));
    }
    return wrapHandler(QUEUES.alerts, alertEvaluationHandler(pool), deps)(job);
  }) as Processor,
  [QUEUES.twinSnapshots]: (async (job) => {
    // Opt-in: without TWIN_SNAPSHOTS_ENABLED the job completes without reading or writing anything.
    const objectStorage = twinObjectStorage;
    if (!objectStorage) return { skipped: "twin snapshots are disabled" };
    if (job.name === "sweep") {
      const bucket: string = job.data.bucket ?? timeBucket(new Date(), 60);
      const view = { id: job.id, name: job.name, attemptsMade: job.attemptsMade, opts: job.opts, discard: () => job.discard(), data: { bucket, idempotencyKey: `twin-snapshots-sweep:${bucket}` } };
      return wrapHandler("twin-snapshots-sweep", twinSnapshotSweepHandler(pool, enqueue), deps)(view);
    }
    return wrapHandler(QUEUES.twinSnapshots, twinSnapshotHandler(pool, (tenantId) => createObjectContentStore(objectStorage, tenantId)), deps)(job);
  }) as Processor,
  [QUEUES.twinSnapshotBatches]: (async (job) => {
    // Opt-in: without TWIN_SNAPSHOT_BATCHES_ENABLED the job completes without reading or writing anything.
    // Batches are data only; nothing is anchored or written on-chain.
    if (!env.TWIN_SNAPSHOT_BATCHES_ENABLED) return { skipped: "twin snapshot batches are disabled" };
    if (job.name === "sweep") {
      const bucket: string = job.data.bucket ?? timeBucket(new Date(), 60);
      const view = { id: job.id, name: job.name, attemptsMade: job.attemptsMade, opts: job.opts, discard: () => job.discard(), data: { bucket, idempotencyKey: `twin-snapshot-batches-sweep:${bucket}` } };
      return wrapHandler("twin-snapshot-batches-sweep", twinSnapshotBatchSweepHandler(pool, enqueue), deps)(view);
    }
    return wrapHandler(QUEUES.twinSnapshotBatches, twinSnapshotBatchHandler(pool), deps)(job);
  }) as Processor,
  [QUEUES.ownershipIndex]: (async (job) => {
    // Opt-in and read-only: without TWIN_OWNERSHIP_INDEX_ENABLED and an event source, nothing is read or written.
    if (!env.TWIN_OWNERSHIP_INDEX_ENABLED) return { skipped: "ownership index is disabled" };
    const source = ownershipEventSource;
    if (!source) return { skipped: "no ownership event source is configured" };
    if (job.name === "sweep") {
      const bucket: string = job.data.bucket ?? timeBucket(new Date(), 60);
      const view = { id: job.id, name: job.name, attemptsMade: job.attemptsMade, opts: job.opts, discard: () => job.discard(), data: { bucket, idempotencyKey: `ownership-index-sweep:${bucket}` } };
      return wrapHandler("ownership-index-sweep", ownershipIndexSweepHandler(pool, enqueue), deps)(view);
    }
    return wrapHandler(QUEUES.ownershipIndex, ownershipIndexHandler(pool, source, ownershipIdentityGuard), deps)(job);
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

// Queue depth is read from Redis at scrape time, and only when metrics are exposed.
const depthQueues = env.METRICS_TOKEN ? Object.keys(processors).map((name) => new Queue(name, { connection, prefix })) : [];
if (depthQueues.length > 0)
  createQueueDepthGauge(metricsRegistry, async (g) => {
    for (const q of depthQueues) {
      const counts = await q.getJobCounts(...QUEUE_STATES);
      for (const state of QUEUE_STATES) g.set({ queue: q.name, state }, counts[state] ?? 0);
    }
  });

const health = startHealthServer({
  port: env.HEALTH_PORT,
  isDraining: () => shutdown.isShuttingDown,
  metrics: { token: env.METRICS_TOKEN, render: () => metricsRegistry.render() },
  checks: [
    { name: "database", check: () => pingDatabase(pool) },
    { name: "redis", check: async () => (await connection.ping()) === "PONG" },
  ],
});

// Sensor telemetry over MQTT (TLS), when a broker is configured.
const telemetry = env.MQTT_URL
  ? startTelemetryConsumer(
      {
        url: env.MQTT_URL,
        clientId: env.MQTT_CLIENT_ID,
        username: env.MQTT_USERNAME,
        password: env.MQTT_PASSWORD,
        ca: env.MQTT_CA_PEM,
        cert: env.MQTT_CLIENT_CERT_PEM,
        key: env.MQTT_CLIENT_KEY_PEM,
        prefix: env.MQTT_TOPIC_PREFIX,
        batchSize: env.MQTT_BATCH_SIZE,
        flushMs: env.MQTT_FLUSH_MS,
      },
      pool,
      logger,
    )
  : undefined;

// Awaited: Solana endpoints prove their cluster before any rail exists, and a wrong cluster stops the worker.
const rwaEngine = await startRwaEngine(env, pool, logger);

shutdown.register({ name: "postgres", close: () => pool.end() });
shutdown.register({ name: "redis", close: async () => void (await connection.quit()) });
shutdown.register({ name: "producers", close: async () => void (await Promise.all([...producers.values(), deadLetterQueue].map((q) => q.close()))) });
// Workers close first: stop taking new jobs and wait for in-flight ones to finish.
shutdown.register({ name: "workers", close: async () => void (await Promise.all(workers.map((w) => w.close()))) });
shutdown.register({ name: "health", close: () => new Promise<void>((r) => health.close(() => r())) });
if (depthQueues.length > 0) shutdown.register({ name: "metrics-queues", close: async () => void (await Promise.all(depthQueues.map((q) => q.close()))) });
// Telemetry flushes what it holds before the database closes.
if (telemetry) shutdown.register({ name: "telemetry", close: () => telemetry.close() });
// The engine finishes its current step before the database closes.
if (rwaEngine) shutdown.register({ name: "rwa-engine", close: () => rwaEngine.close() });

logger.info({ queues: Object.keys(processors), concurrency: env.WORKER_CONCURRENCY }, "worker started");
