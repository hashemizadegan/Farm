import { apiEnvSchema, loadEnv } from "@metafarm/config";
import { createPool } from "@metafarm/db";
import { createLogger, installGracefulShutdown } from "@metafarm/observability";
import { recoverMessageAddress } from "viem";
import { httpTron } from "@metafarm/chain";
import { buildApp } from "./app";
import { createDevProvider } from "./auth/dev";
import { createOidcProvider } from "./auth/oidc";
import type { AuthProvider } from "./auth/provider";
import { createHarvestChainReader } from "./lib/harvest-chain";
import { createBullProducer } from "./queue/producer";
import { createMemoryStorage } from "./storage/memory";
import { createS3Storage } from "./storage/s3";

const env = loadEnv(apiEnvSchema);
const logger = createLogger({
  service: env.SERVICE_NAME ?? "api",
  level: env.LOG_LEVEL,
  environment: env.APP_ENV,
  pretty: env.APP_ENV === "development",
});

function authProvider(): AuthProvider {
  if (env.AUTH_PROVIDER === "oidc") {
    if (!env.OIDC_ISSUER_URL || !env.OIDC_AUDIENCE) throw new Error("OIDC_ISSUER_URL and OIDC_AUDIENCE are required");
    return createOidcProvider({ issuerUrl: env.OIDC_ISSUER_URL, audience: env.OIDC_AUDIENCE, jwksUrl: env.OIDC_JWKS_URL });
  }
  if (!env.DEV_AUTH_SECRET) throw new Error("DEV_AUTH_SECRET is required for the dev auth provider");
  logger.warn("using the development auth provider; do not expose this instance publicly");
  return createDevProvider(env.DEV_AUTH_SECRET);
}

function storage() {
  if (env.STORAGE_DRIVER === "memory") return createMemoryStorage();
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new Error("S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for s3 storage");
  }
  return createS3Storage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}

const pool = createPool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX, ssl: env.DATABASE_SSL, applicationName: "metafarm-api" });
const jobs = createBullProducer(env.REDIS_URL, env.QUEUE_PREFIX);
const shutdown = installGracefulShutdown(logger, env.SHUTDOWN_GRACE_MS);

const app = await buildApp({
  deps: {
    env,
    logger,
    pool,
    jobs,
    storage: storage(),
    auth: authProvider(),
    recoverMessageAddress: (message, signature) => recoverMessageAddress({ message, signature }),
    now: () => new Date(),
    harvestChain:
      env.CHAIN_RPC_URL && env.HARVEST_REGISTRY_ADDRESS ? createHarvestChainReader(env.CHAIN_RPC_URL, env.HARVEST_REGISTRY_ADDRESS) : undefined,
    tron: env.RWA_TRON_API_URL ? httpTron(env.RWA_TRON_API_URL, { apiKey: env.RWA_TRON_API_KEY }) : undefined,
  },
  isDraining: () => shutdown.isShuttingDown,
});

// Close order (reverse of registration): HTTP server first, then queue, then DB.
shutdown.register({ name: "postgres", close: () => pool.end() });
shutdown.register({ name: "queue", close: () => jobs.close() });
shutdown.register({ name: "http", close: () => app.close() });

await app.listen({ port: env.PORT, host: env.HOST });
