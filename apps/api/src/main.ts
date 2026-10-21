import { apiDocsEnabled, apiEnvSchema, loadEnv } from "@metafarm/config";
import { createPool, readOwnershipIndex } from "@metafarm/db";
import { createLogger, installGracefulShutdown } from "@metafarm/observability";
import { recoverMessageAddress } from "viem";
import { IndexOwnershipReader, httpSolanaRpc, httpTron } from "@metafarm/chain";
import { buildApp } from "./app";
import { createDevProvider } from "./auth/dev";
import { createOidcProvider } from "./auth/oidc";
import type { AuthProvider } from "./auth/provider";
import { createHarvestChainReader } from "./lib/harvest-chain";
import { createBullProducer } from "./queue/producer";
import { createStorageFromEnv } from "@metafarm/storage";
import { solanaClusterCheck } from "./lib/solana-cluster";
import { createRateLimitRedis } from "./lib/rate-limit-redis";

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

const storage = () => createStorageFromEnv(env);

const pool = createPool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX, ssl: env.DATABASE_SSL, applicationName: "metafarm-api" });
const jobs = createBullProducer(env.REDIS_URL, env.QUEUE_PREFIX);
const rateLimitRedis = env.RATE_LIMIT_STORE === "redis" ? createRateLimitRedis(env.REDIS_URL, logger) : undefined;
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
    solanaRpc: env.RWA_SOLANA_RPC_URL ? httpSolanaRpc(env.RWA_SOLANA_RPC_URL) : undefined,
    // Ownership from the platform's index (read-only, off by default): without it, ownership reads `not_indexed`.
    ownershipReader: env.TWIN_OWNERSHIP_INDEX_ENABLED ? new IndexOwnershipReader((asset) => readOwnershipIndex(pool, asset)) : undefined,
    rateLimitRedis,
    solanaCluster: env.RWA_SOLANA_RPC_URL ? solanaClusterCheck(() => ({ url: env.RWA_SOLANA_RPC_URL!, network: env.RWA_SOLANA_NETWORK })) : undefined,
  },
  isDraining: () => shutdown.isShuttingDown,
  docs: apiDocsEnabled(env),
});

// Close order (reverse of registration): HTTP server first, then queue, then DB.
shutdown.register({ name: "postgres", close: () => pool.end() });
shutdown.register({ name: "queue", close: () => jobs.close() });
if (rateLimitRedis) shutdown.register({ name: "rate-limit-redis", close: async () => void (await rateLimitRedis.quit()) });
shutdown.register({ name: "http", close: () => app.close() });

await app.listen({ port: env.PORT, host: env.HOST });
