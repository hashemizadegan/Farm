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
  WALLET_AUTH_DOMAIN: z.string().min(1).default("localhost:3000"),
  WALLET_AUTH_URI: z.string().url().default("http://localhost:3000"),
  WALLET_ALLOWED_CHAIN_IDS: csv.pipe(z.array(z.coerce.number().int().positive())).default("31337"),
  WALLET_NONCE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  CHAIN_RPC_URL: z.string().url().optional(),
  CHAIN_ID: z.coerce.number().int().positive().default(31337),
  NFT_ERC721_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  NFT_ERC1155_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  CHAIN_CONFIRMATIONS: z.coerce.number().int().min(0).max(256).default(12),
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
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
    RATE_LIMIT_WINDOW: z.string().default("1 minute"),
    TRUST_PROXY: bool.default("true"),
    WEBHOOK_SIGNING_SECRETS: csv.default(""),
    WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(15_000),
  })
  .superRefine(productionGuards);

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
    HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(30_000),
  })
  .superRefine(productionGuards);

export const schedulerEnvSchema = z
  .object({
    ...base,
    ...redis,
    HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4200),
    ALERT_EVALUATION_CRON: z.string().default("*/5 * * * *"),
    CHAIN_INDEX_CRON: z.string().default("*/1 * * * *"),
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
  NEXT_PUBLIC_WALLET_CHAIN_ID: z.coerce.number().int().positive().default(31337),
});
export type WebPublicEnv = z.infer<typeof webPublicEnvSchema>;
