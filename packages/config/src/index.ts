import { z } from "zod";

/**
 * Centralised, validated environment configuration.
 *
 * Every service parses its own subset at boot and refuses to start on invalid
 * configuration. No defaults are provided for secrets.
 */

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const csv = z
  .string()
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

export const AppEnvironment = z.enum(["development", "test", "staging", "production"]);
export type AppEnvironment = z.infer<typeof AppEnvironment>;

const base = {
  APP_ENV: AppEnvironment.default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  SERVICE_NAME: z.string().min(1).optional(),
};

const database = {
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: bool.default("false"),
};

const redis = {
  REDIS_URL: z.string().url(),
  QUEUE_PREFIX: z.string().min(1).default("metafarm"),
};

const storage = {
  STORAGE_DRIVER: z.enum(["s3", "memory"]).default("memory"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default("true"),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  /**
   * direct: the browser PUTs to a presigned storage URL (needs bucket CORS).
   * proxy: the browser PUTs to the API, which writes to storage. Use when the
   * bucket cannot be given a CORS policy (e.g. Railway buckets).
   */
  UPLOAD_MODE: z.enum(["direct", "proxy"]).default("direct"),
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1).default(25 * 1024 * 1024),
};

const auth = {
  AUTH_PROVIDER: z.enum(["oidc", "dev"]).default("dev"),
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().optional(),
  OIDC_JWKS_URL: z.string().url().optional(),
  /** Only used by the development auth provider. Must never be set in production. */
  DEV_AUTH_SECRET: z.string().min(32).optional(),
};

const chain = {
  /** The domain and origin named in the player-wallet link message (J8), and its lifetime. */
  WALLET_AUTH_DOMAIN: z.string().min(1).default("localhost:3000"),
  WALLET_AUTH_URI: z.string().url().default("http://localhost:3000"),
  WALLET_NONCE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  CHAIN_RPC_URL: z.string().url().optional(),
  CHAIN_ID: z.coerce.number().int().positive().default(31337),
  NFT_ERC721_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  NFT_ERC1155_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  CHAIN_CONFIRMATIONS: z.coerce.number().int().min(0).max(256).default(12),
  /** HarvestRegistry contract; harvest batches are registered on-chain only when this and CHAIN_RPC_URL are set. */
  HARVEST_REGISTRY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** Display name of the chain, e.g. "Base Sepolia". */
  CHAIN_NAME: z.string().max(60).optional(),
  /** Transaction page prefix of a block explorer, e.g. https://sepolia.basescan.org/tx/ */
  CHAIN_EXPLORER_TX_URL: z.string().url().optional(),
};

/** Real-world asset rails: mainnets stay closed until legal and compliance sign-off. */
const rwa = {
  RWA_MAINNET_ENABLED: bool.default("false"),
  /** Sanctions screenings older than this no longer count. */
  RWA_SCREENING_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** ISO 3166-1 alpha-2 codes excluded by the operator's counsel; empty by default. */
  RWA_BLOCKED_JURISDICTIONS: csv.default(""),
  /** Solana JSON-RPC endpoint and network for share tokens. */
  RWA_SOLANA_RPC_URL: z.string().url().optional(),
  RWA_SOLANA_NETWORK: z.enum(["solana-devnet", "solana-mainnet"]).default("solana-devnet"),
  /** The address that signs issuance (mint authority of linked share tokens). */
  RWA_SOLANA_ISSUER: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "a Solana address").optional(),
  /** TRON full-node HTTP API (e.g. https://nile.trongrid.io): verifies incoming payments, sends payouts. */
  RWA_TRON_API_URL: z.string().url().optional(),
  RWA_TRON_API_KEY: z.string().min(1).optional(),
  RWA_TRON_NETWORK: z.enum(["tron-nile", "tron-shasta", "tron-mainnet"]).default("tron-nile"),
  /** The operator's TRON treasury: receives subscriptions and pays redemptions and distributions. */
  RWA_TRON_TREASURY: z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/, "a TRON address").optional(),
  /**
   * Public base URL of this API, used in compressed NFT metadata URIs (`<base>/v1/public/rwa/cnft/<id>`).
   * Unset: registrations are refused. Keep it short: the whole URI must fit in 200 bytes.
   */
  RWA_CNFT_METADATA_BASE_URL: z.string().url().optional(),
};

export const apiEnvSchema = z
  .object({
    ...base,
    ...database,
    ...redis,
    ...storage,
    ...auth,
    ...chain,
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().default("0.0.0.0"),
    CORS_ORIGINS: csv.default("http://localhost:3000"),
    BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(1024 * 1024),
    // Per client IP per window. A farm team often shares one connection, and the app polls while pages are open.
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(1200),
    RATE_LIMIT_WINDOW: z.string().default("1 minute"),
    /**
     * Where rate-limit counters live. `memory` (default) counts per API process, so each replica has its
     * own budget. `redis` shares the counters across replicas through REDIS_URL. If Redis cannot be
     * reached, requests are served without limiting (fail open) and the error is logged.
     */
    RATE_LIMIT_STORE: z.enum(["memory", "redis"]).default("memory"),
    /**
     * Bearer token for GET /metrics (Prometheus text). Unset (default): the endpoint answers 404 and
     * nothing is exposed. A platform secret; never commit it or put it in a URL.
     */
    METRICS_TOKEN: z.string().min(32).optional(),
    /**
     * J8: let signed-in users link Solana player wallets (GET/POST/DELETE /v1/me/player-wallets) by
     * signing a one-time message in their own wallet. Off (default): those routes answer 404. The
     * platform never signs; this is unrelated to RWA party wallets.
     */
    PLAYER_WALLETS_ENABLED: bool.default("false"),
    TRUST_PROXY: bool.default("true"),
    /**
     * Private-preview access gate (API side). On: every route except /healthz, /readyz and CORS preflights needs
     * a verified bearer token (the configured auth provider), so unauthenticated endpoints (docs, public metadata,
     * webhooks) are closed too. Off (default): unchanged. Meant for an isolated preview deployment; the web app
     * has its own gate (PREVIEW_ACCESS_GATE / PREVIEW_ACCESS_PASSWORD, read by apps/web/src/middleware.ts).
     */
    PREVIEW_ACCESS_GATE: bool.default("false"),
    WEBHOOK_SIGNING_SECRETS: csv.default(""),
    /** Let a signed-in user with no workspace create one and become its owner. */
    SELF_SERVE_WORKSPACES: bool.default("true"),
    /** Cap on workspaces one user may own through self-service (abuse guard). */
    MAX_OWNED_WORKSPACES: z.coerce.number().int().min(1).max(100).default(3),
    WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(15_000),
    /** Serve Swagger UI at /docs. Unset: on in development and test, off in staging and production. */
    API_DOCS_ENABLED: bool.optional(),
    /** Digital twin: report ownership from the platform's ownership index (migration 0020). Off by default: ownership then reads `not_indexed`. Read-only. */
    TWIN_OWNERSHIP_INDEX_ENABLED: bool.default("false"),
    /**
     * Y9: the yield preparer and reviewer workflow (POST /v1/tenants/{tenantId}/yield/...), for simulation cycles
     * only. Off (default): those routes answer 404. Refused in production: real cycles need the approvals of the
     * real-yield plan (§11.1). Nothing is funded, signed or submitted either way.
     */
    YIELD_WORKFLOW_ENABLED: bool.default("false"),
    /**
     * Y12 (D-29): explicit, consented, authorised, revocable account-to-party links. Off (default): those routes
     * answer 404. Refused in production: the consent wording is not legally approved (D-39) and the security
     * sign-off is outstanding.
     */
    PARTY_LINKS_ENABLED: bool.default("false"),
    /**
     * Y13: holder-facing yield reads (GET /v1/tenants/{tenantId}/me/yield/allocations) through an active account
     * link (PARTY_LINKS_ENABLED). Simulation cycles only. Off (default): 404. Refused in staging and production:
     * holder disclosures are not approved (D-39), nor D-15, D-25 and D-27.
     */
    HOLDER_YIELD_ENABLED: bool.default("false"),
    /**
     * Y13: unsigned simulation claim-intent batches, built from persisted leaves (migration 0029). Data only: nothing
     * is signed or submitted. Needs YIELD_WORKFLOW_ENABLED too. Off (default): 404. Refused in staging and production
     * (D-15, D-25, D-27, D-39).
     */
    YIELD_CLAIM_INTENTS_ENABLED: bool.default("false"),
    ...rwa,
  })
  .superRefine(productionGuards)
  .superRefine((env, ctx) => {
    if (env.YIELD_WORKFLOW_ENABLED && env.APP_ENV === "production") {
      ctx.addIssue({ code: "custom", path: ["YIELD_WORKFLOW_ENABLED"], message: "the yield workflow is simulation-only and not approved for production" });
    }
    if (env.PARTY_LINKS_ENABLED && env.APP_ENV === "production") {
      ctx.addIssue({ code: "custom", path: ["PARTY_LINKS_ENABLED"], message: "account-to-party links are not approved for production (D-29, D-39)" });
    }
    if (env.YIELD_CLAIM_INTENTS_ENABLED && (env.APP_ENV === "production" || env.APP_ENV === "staging")) {
      ctx.addIssue({ code: "custom", path: ["YIELD_CLAIM_INTENTS_ENABLED"], message: "claim intents are simulation-only and refused when deployed (D-15, D-25, D-27, D-39)" });
    }
    if (env.HOLDER_YIELD_ENABLED && (env.APP_ENV === "production" || env.APP_ENV === "staging")) {
      ctx.addIssue({ code: "custom", path: ["HOLDER_YIELD_ENABLED"], message: "holder-facing yield views need approved disclosures (D-39) before any deployed use" });
    }
  });

/** Whether the API serves its interactive docs: an explicit setting wins, else only outside deployed environments. */
export function apiDocsEnabled(env: { APP_ENV: string; API_DOCS_ENABLED?: boolean }): boolean {
  return env.API_DOCS_ENABLED ?? !(env.APP_ENV === "staging" || env.APP_ENV === "production");
}

export const workerEnvSchema = z
  .object({
    ...base,
    ...database,
    ...redis,
    ...storage,
    ...chain,
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(25).default(5),
    JOB_BACKOFF_BASE_MS: z.coerce.number().int().min(100).default(2_000),
    IMAGERY_PROVIDER: z.enum(["none", "mock"]).default("none"),
    /**
     * Hot key that registers harvest batches. It should hold only RECORDER_ROLE on
     * the registry and a small amount of gas money. Set it in the platform's secret store.
     */
    CHAIN_SIGNER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "0x followed by 64 hex characters").optional(),
    /** Seconds to wait for a registration transaction before retrying later. */
    CHAIN_TX_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(900).default(120),
    HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
    /**
     * Bearer token for GET /metrics on HEALTH_PORT (Prometheus text). Unset (default): the endpoint answers 404 and
     * nothing is exposed. A platform secret; never commit it or put it in a URL.
     */
    METRICS_TOKEN: z.string().min(32).optional(),
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(30_000),
    /** MQTT broker for sensor telemetry (mqtts:// or wss://). Unset: no MQTT consumer. */
    MQTT_URL: z.string().url().optional(),
    MQTT_CLIENT_ID: z.string().min(1).max(64).default("metafarm-worker"),
    MQTT_USERNAME: z.string().min(1).optional(),
    MQTT_PASSWORD: z.string().min(1).optional(),
    /** PEM: the broker's CA, and this client's certificate and key for mutual TLS. */
    MQTT_CA_PEM: z.string().min(1).optional(),
    MQTT_CLIENT_CERT_PEM: z.string().min(1).optional(),
    MQTT_CLIENT_KEY_PEM: z.string().min(1).optional(),
    MQTT_TOPIC_PREFIX: z.string().regex(/^[a-z0-9_-]{1,32}$/).default("metafarm"),
    MQTT_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(500),
    MQTT_FLUSH_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
    /** Local development only: allow mqtt:// and ws:// without TLS. */
    MQTT_ALLOW_INSECURE: bool.default("false"),
    ...rwa,
    /** How long the second leg of an order may lag the first before reconciliation reports it. */
    RWA_RECONCILIATION_SLA_MINUTES: z.coerce.number().int().min(5).max(10_080).default(60),
    /**
     * Devnet only: the issuer's key (base58, Solana CLI format) as a platform secret. Refused when
     * mainnets are enabled; production issuance signs through a KMS/HSM adapter.
     */
    RWA_SOLANA_SIGNER_SECRET: z.string().min(32).optional(),
    /** Compute-unit price ceiling for issuance transactions (micro-lamports). */
    RWA_SOLANA_MAX_PRIORITY_FEE: z.coerce.bigint().min(0n).default(1_000_000n),
    /** Testnets only: the treasury's TRON key (hex) as a platform secret. Refused when mainnets are enabled. */
    RWA_TRON_SIGNER_PRIVATE_KEY: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, "64 hex characters").optional(),
    /** Most TRX (sun) one payout may burn for energy. */
    RWA_TRON_MAX_FEE_LIMIT_SUN: z.coerce.bigint().min(1n).default(100_000_000n),
    /** A DAS-capable Solana RPC endpoint; compressed NFTs (registrations) run only when this is set. */
    RWA_SOLANA_DAS_URL: z.string().url().optional(),
    /** Leaves each new Bubblegum tree is planned for (rounded up to a power of two by the tree shape). */
    RWA_CNFT_TREE_CAPACITY: z.coerce.number().int().min(8).max(1_048_576).default(16_384),
    /**
     * Opt-in, read-only check of the Solana endpoints while no signer is set: getGenesisHash on the
     * RPC and DAS endpoints, and whether DAS knows getAsset/getAssetProof. Off: no outbound call.
     */
    RWA_PREFLIGHT_ENABLED: bool.default("false"),
    /** Digital twin: record scheduled farm-state snapshots (content-addressed storage + a data commitment). Off by default; writes nothing on-chain. */
    TWIN_SNAPSHOTS_ENABLED: bool.default("false"),
    /** Digital twin: fix recorded snapshot commitments into Merkle batches (one root per workspace and run). Off by default; data only, nothing on-chain. */
    TWIN_SNAPSHOT_BATCHES_ENABLED: bool.default("false"),
    /** Digital twin: run ownership-index jobs (read finalized ownership events into the index). Off by default; also needs an event source. Read-only on chain. */
    TWIN_OWNERSHIP_INDEX_ENABLED: bool.default("false"),
  })
  .superRefine(productionGuards)
  .superRefine((env, ctx) => {
    if (env.RWA_MAINNET_ENABLED && env.RWA_SOLANA_SIGNER_SECRET) {
      ctx.addIssue({ code: "custom", path: ["RWA_SOLANA_SIGNER_SECRET"], message: "in-process signing keys are refused when mainnets are enabled" });
    }
    if (env.RWA_MAINNET_ENABLED && env.RWA_TRON_SIGNER_PRIVATE_KEY) {
      ctx.addIssue({ code: "custom", path: ["RWA_TRON_SIGNER_PRIVATE_KEY"], message: "in-process signing keys are refused when mainnets are enabled" });
    }
    if (env.MQTT_URL) {
      const tls = /^(mqtts|wss):\/\//.test(env.MQTT_URL);
      if (!tls && (!env.MQTT_ALLOW_INSECURE || env.APP_ENV === "production" || env.APP_ENV === "staging")) {
        ctx.addIssue({ code: "custom", path: ["MQTT_URL"], message: "MQTT must use TLS (mqtts:// or wss://)" });
      }
      if (Boolean(env.MQTT_CLIENT_CERT_PEM) !== Boolean(env.MQTT_CLIENT_KEY_PEM)) {
        ctx.addIssue({ code: "custom", path: ["MQTT_CLIENT_KEY_PEM"], message: "set both the client certificate and key, or neither" });
      }
    }
  });

export const schedulerEnvSchema = z
  .object({
    ...base,
    ...redis,
    HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4200),
    ALERT_EVALUATION_CRON: z.string().default("*/5 * * * *"),
    CHAIN_INDEX_CRON: z.string().default("*/1 * * * *"),
    /** Digital twin: cron for the farm-snapshot sweep. Unset = no schedule (the default). */
    TWIN_SNAPSHOT_CRON: z.string().min(9).max(100).optional(),
    /** Digital twin: cron for batching snapshot commitments. Unset = no schedule (the default). */
    TWIN_SNAPSHOT_BATCH_CRON: z.string().min(9).max(100).optional(),
    /** Digital twin: cron for the ownership-index sweep. Unset = no schedule (the default). */
    TWIN_OWNERSHIP_INDEX_CRON: z.string().min(9).max(100).optional(),
    CHAIN_ID: z.coerce.number().int().positive().default(31337),
    /** Comma-separated "0xaddress@fromBlock" entries. */
    CHAIN_INDEX_CONTRACTS: csv.default(""),
    SCHEDULER_TZ: z.string().default("UTC"),
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),
  })
  .superRefine(productionGuards);

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type SchedulerEnv = z.infer<typeof schedulerEnvSchema>;

/** Guards that make unsafe configuration fail fast outside development. */
function productionGuards(env: Record<string, unknown>, ctx: z.RefinementCtx) {
  const deployed = env.APP_ENV === "staging" || env.APP_ENV === "production";
  if (!deployed) return;
  if (env.AUTH_PROVIDER === "dev") {
    ctx.addIssue({ code: "custom", path: ["AUTH_PROVIDER"], message: "dev auth is not allowed in staging/production" });
  }
  if (env.DEV_AUTH_SECRET) {
    ctx.addIssue({ code: "custom", path: ["DEV_AUTH_SECRET"], message: "must not be set in staging/production" });
  }
  if (env.STORAGE_DRIVER === "memory") {
    ctx.addIssue({ code: "custom", path: ["STORAGE_DRIVER"], message: "memory storage is not allowed when deployed" });
  }
  if (env.IMAGERY_PROVIDER === "mock") {
    ctx.addIssue({ code: "custom", path: ["IMAGERY_PROVIDER"], message: "mock imagery is not allowed when deployed" });
  }
  if (Array.isArray(env.CORS_ORIGINS) && env.CORS_ORIGINS.some((o) => o === "*")) {
    ctx.addIssue({ code: "custom", path: ["CORS_ORIGINS"], message: "wildcard CORS is not allowed when deployed" });
  }
}

export function loadEnv<T extends z.ZodTypeAny>(schema: T, source: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Public web configuration. Only NEXT_PUBLIC_* values may appear here. */
export const webPublicEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  NEXT_PUBLIC_MAP_STYLE_URL: z.string().optional(),
  NEXT_PUBLIC_MAP_ATTRIBUTION: z.string().optional(),
  NEXT_PUBLIC_CESIUM_ENABLED: bool.default("false"),
  /** J8: show player-wallet linking on the account page (needs PLAYER_WALLETS_ENABLED on the API). */
  NEXT_PUBLIC_PLAYER_WALLETS_ENABLED: bool.default("false"),
  /** Y10: show the internal yield pages (staff only; read-only; needs yield:read). The web build refuses it when APP_ENV is staging or production until a disclosure version is approved (D-39). */
  NEXT_PUBLIC_YIELD_PAGES_ENABLED: bool.default("false"),
});
export type WebPublicEnv = z.infer<typeof webPublicEnvSchema>;
