/**
 * Railway Infrastructure as Code for the whole project (one environment per
 * `railway link`; run `railway config plan` then `railway config apply` for
 * staging and production separately).
 *
 * Railway marks per-service railway.json/railway.toml ("config as code") as
 * deprecated in favour of this file, so this repository ships only IaC plus
 * the manual settings table in docs/deployment-railway.md.
 *
 * IMPORTANT: omitting a resource from this file deletes it on apply. Review
 * `railway config plan` output before every apply, especially in production.
 *
 * Build: each app has its own Dockerfile and builds from the repository root.
 * RAILWAY_DOCKERFILE_PATH selects the Dockerfile per service.
 */
import { defineRailway, github, image, preserve, project, redis, service, volume, bucket } from "railway/iac";

// GitHub repository; staging deploys from the `staging` branch, production from `main`.
const REPO = "hashemizadegan/Farm";

export default defineRailway((ctx) => {
  const prod = ctx.isEnvironment("production");
  const branch = prod ? "main" : "staging";
  const src = () => github(REPO, { branch, rootDirectory: "/" });

  // PostgreSQL with PostGIS from the official postgis image, with a persistent volume.
  // If you prefer a Railway-managed Postgres, replace this with postgres("postgres") AND
  // confirm `CREATE EXTENSION postgis` succeeds on it before migrating.
  const pgData = volume("postgres-data", { sizeMB: prod ? 20_480 : 5_120 });
  const db = service("postgres", {
    source: image("postgis/postgis:16-3.4"),
    volumeMounts: { "/var/lib/postgresql/data": pgData },
    env: {
      POSTGRES_USER: "metafarm",
      POSTGRES_DB: "metafarm",
      POSTGRES_PASSWORD: preserve(), // set once in the dashboard; never commit
      PGDATA: "/var/lib/postgresql/data/pgdata",
    },
  });
  const cache = redis("redis");
  const uploads = bucket("uploads", { region: "iad" }); // TODO(provider-config): pick a region; it cannot change later.

  const dbUrl = "postgres://metafarm:${{postgres.POSTGRES_PASSWORD}}@postgres.railway.internal:5432/metafarm";

  const common = {
    APP_ENV: prod ? "production" : "staging",
    LOG_LEVEL: "info",
    HOST: "::", // accept IPv4 and IPv6 (Railway's private network uses IPv6 addressing)
    DATABASE_URL: dbUrl,
    REDIS_URL: cache.env.REDIS_URL,
    QUEUE_PREFIX: "metafarm",
  };

  const storageEnv = {
    STORAGE_DRIVER: "s3",
    // TODO(provider-config): map these to the bucket's credentials as exposed by Railway
    // (or to an external S3-compatible provider). Keep the bucket private.
    S3_ENDPOINT: preserve(),
    S3_REGION: preserve(),
    S3_BUCKET: preserve(),
    S3_ACCESS_KEY_ID: preserve(),
    S3_SECRET_ACCESS_KEY: preserve(),
  };

  const api = service("api", {
    source: src(),
    preDeploy: "node dist/migrate.js",
    healthcheck: "/readyz",
    healthcheckTimeout: 60,
    replicas: prod ? 2 : 1,
    env: {
      ...common,
      ...storageEnv,
      RAILWAY_DOCKERFILE_PATH: "apps/api/Dockerfile",
      AUTH_PROVIDER: "oidc",
      OIDC_ISSUER_URL: preserve(),
      OIDC_AUDIENCE: preserve(),
      CORS_ORIGINS: preserve(), // the web service's public origin(s), comma-separated
      WEBHOOK_SIGNING_SECRETS: preserve(),
      WALLET_AUTH_DOMAIN: preserve(),
      WALLET_AUTH_URI: preserve(),
      WALLET_ALLOWED_CHAIN_IDS: preserve(),
      AUDIT_IP_SALT: preserve(),
      SHUTDOWN_GRACE_MS: "15000",
    },
  });

  const worker = service("worker", {
    source: src(),
    healthcheck: "/healthz",
    replicas: prod ? 2 : 1,
    env: {
      ...common,
      ...storageEnv,
      RAILWAY_DOCKERFILE_PATH: "apps/worker/Dockerfile",
      WORKER_CONCURRENCY: "4",
      IMAGERY_PROVIDER: "none",
      CHAIN_RPC_URL: preserve(),
      CHAIN_ID: preserve(),
      SHUTDOWN_GRACE_MS: "30000",
    },
  });

  // Exactly one scheduler: job schedulers live in Redis and are idempotent, but one replica keeps logs simple.
  const scheduler = service("scheduler", {
    source: src(),
    healthcheck: "/healthz",
    replicas: 1,
    env: {
      ...common,
      RAILWAY_DOCKERFILE_PATH: "apps/scheduler/Dockerfile",
      CHAIN_ID: preserve(),
      CHAIN_INDEX_CONTRACTS: preserve(),
    },
  });

  const web = service("web", {
    source: src(),
    healthcheck: "/sign-in",
    replicas: prod ? 2 : 1,
    env: {
      RAILWAY_DOCKERFILE_PATH: "apps/web/Dockerfile",
      // Browser-facing: must be the API's PUBLIC URL (inlined at build time).
      NEXT_PUBLIC_API_URL: preserve(),
      NEXT_PUBLIC_MAP_STYLE_URL: preserve(),
      NEXT_PUBLIC_MAP_ATTRIBUTION: preserve(),
      NEXT_PUBLIC_MAP_CONNECT_SRC: preserve(),
      NEXT_PUBLIC_WALLET_CHAIN_ID: preserve(),
    },
  });

  return project("metafarm", { resources: [db, pgData, cache, uploads, api, worker, scheduler, web] });
});
