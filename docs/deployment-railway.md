# Deploying to Railway

> For a click-by-click first deployment (Auth0 + Railway bucket), see [railway-staging-setup.md](railway-staging-setup.md).

Four application services plus three data services, per environment:

| Service | Source | Public? | Health check | Notes |
| --- | --- | --- | --- | --- |
| `web` | root `Dockerfile` (app `web`) | Yes (custom domain) | `GET /sign-in` | Next.js standalone server |
| `api` | root `Dockerfile` (app `api`) | Yes (custom domain) | `GET /readyz` | Runs migrations as the pre-deploy command |
| `worker` | root `Dockerfile` (app `worker`) | No | `GET /healthz` on `$PORT` | BullMQ consumers |
| `scheduler` | root `Dockerfile` (app `scheduler`) | No | `GET /healthz` on `$PORT` | One replica |
| `postgres` | `postgis/postgis:16-3.4` image + volume | No | — | PostGIS is required |
| `redis` | Railway Redis | No | — | Queue backend |
| `uploads` | Railway bucket or external S3-compatible storage | No (presigned URLs only) | — | Private |

Every service builds the **root `Dockerfile`**. It selects the app from the Railway service name (`RAILWAY_SERVICE_NAME`, passed into the build), so the service names must be exactly `web`, `api`, `worker` and `scheduler` — or set a service variable `APP=<name>`. Leave the service's root directory as `/`.

## 1. Infrastructure as Code

`.railway/railway.ts` declares the whole environment using Railway's Infrastructure as Code. Railway documents per-service `railway.json`/`railway.toml` ("config as code") as deprecated, so this repo does not ship them.

```bash
npm i -g @railway/cli            # or follow Railway's CLI install docs
railway login
railway link                     # choose project + environment (staging first)
railway config plan              # review: omitted resources are DELETED on apply
railway config apply
```

Edit the `TODO(provider-config)` markers first (repository, bucket region, storage mapping). Secrets are declared with `preserve()` so values are set in the Railway dashboard and never committed.

If you prefer the dashboard, create the services in the table above and set the variables in §3 manually; the IaC file doubles as a checklist.

## 2. Staging and production separation

- Use **separate Railway environments** (`staging`, `production`) with their own databases, Redis, buckets, secrets and domains. Never point staging at production data.
- `.railway/railway.ts` deploys `staging` from the `staging` branch and `production` from `main`, and scales replicas only in production.
- Use different IdP applications (client IDs/audiences), webhook secrets, S3 credentials and RPC endpoints per environment.
- `APP_ENV=staging|production` turns on guards: the dev auth provider, `DEV_AUTH_SECRET`, memory storage, mock imagery and wildcard CORS all refuse to start.

## 3. Environment variables

Full list with local defaults: `.env.example`. Required when deployed:

| Variable | Services | Notes |
| --- | --- | --- |
| `APP_ENV` | all | `staging` or `production` |
| `DATABASE_URL` | api, worker | Private hostname `postgres.railway.internal` |
| `DATABASE_SSL` | api, worker | `false` on the private network unless you terminate TLS on Postgres |
| `REDIS_URL` | api, worker, scheduler | Reference the Redis service's variable |
| `HOST` | api, worker, scheduler | `::` so the process listens on IPv4 and IPv6 |
| `AUTH_PROVIDER`, `OIDC_ISSUER_URL`, `OIDC_AUDIENCE` | api | `oidc` when deployed |
| `CORS_ORIGINS` | api | The web origin(s), e.g. `https://app.example.com` |
| `STORAGE_DRIVER`, `S3_*` | api, worker | `s3`; bucket must be private and allow browser `PUT` from the web origin via CORS |
| `WEBHOOK_SIGNING_SECRETS` | api | Comma-separated; two during rotation |
| `WALLET_AUTH_DOMAIN`, `WALLET_AUTH_URI`, `WALLET_ALLOWED_CHAIN_IDS` | api | Must match the public web origin |
| `AUDIT_IP_SALT` | api | Random string |
| `API_DOCS_ENABLED` | api (optional) | Swagger UI at `/docs`. Unset: off in `staging` and `production`, on elsewhere. Set `true` only on a private environment |
| `NEXT_PUBLIC_API_URL` | web (**build time**) | The API's **public** URL; browsers cannot reach `*.railway.internal` |
| `NEXT_PUBLIC_MAP_*` | web (build time) | Basemap style/attribution and CSP hosts |
| `NEXT_PUBLIC_OIDC_AUTHORITY`, `NEXT_PUBLIC_OIDC_CLIENT_ID`, `NEXT_PUBLIC_OIDC_AUDIENCE` | web (build time) | Browser sign-in (Authorization Code + PKCE) |
| `CHAIN_RPC_URL`, `CHAIN_ID`, `CHAIN_INDEX_CONTRACTS` | worker, scheduler | Optional; indexing is skipped without an RPC URL |
| `APP` | each app (optional) | Only if the service name is not `web`/`api`/`worker`/`scheduler` |

`NEXT_PUBLIC_*` values are inlined into the browser bundle at build time. Railway exposes service variables to a Docker build only when the Dockerfile declares them with `ARG`; the root `Dockerfile` does this for every `NEXT_PUBLIC_*` value. Changing one requires a rebuild.

## 4. Private service communication

- API, worker and scheduler reach Postgres and Redis over Railway's private network (`<service>.railway.internal`). Postgres, Redis, worker and scheduler need no public domain.
- The browser talks only to `web` and `api` public domains, and to object storage via presigned URLs.
- Processes bind to `HOST=::`.

## 5. Health checks

- `api`: `/readyz` checks Postgres, Redis and object storage; `/healthz` is liveness only. Using `/readyz` for the deploy health check means a deployment with broken credentials never receives traffic.
- `worker` (Postgres + Redis), `scheduler` (Redis): an internal HTTP server on `$PORT` (`HEALTH_PORT` overrides) serves `/healthz` and `/readyz`. Use **`/readyz`** as the deploy health check, so a deployment that cannot reach its dependencies never replaces the running one.
- `web`: no dependency check of its own; any page that renders without the API returns 200 once Next.js serves. Railway accepts only letters, digits, `/` and `_` in a health check path, so `/sign-in` is rejected; `/offline` (always present, client-rendered) qualifies.
- During shutdown `/healthz` and `/readyz` return `503`.
- Railway calls the health check **only while deploying**; it does not monitor afterwards. Use an external uptime check on `/readyz` for that.

## 6. Migrations

- The API service's pre-deploy command is `node dist/migrate.js`. It runs before the new deployment starts serving, takes a Postgres advisory lock (safe if two deploys race), applies pending SQL migrations in order, and refuses to continue if an applied migration file was modified.
- Migrations must be **backwards-compatible with the currently running version** (expand → migrate → contract across two releases), because old and new API instances overlap during a deploy.
- The first migration enables `postgis`, `pgcrypto` and `citext`, and creates the `metafarm_app` role used for row-level security. The connecting user must be allowed to create extensions and roles (true for the `postgis/postgis` image's superuser).
- `migrate:down` is blocked in **staging and production** unless `ALLOW_DESTRUCTIVE_MIGRATIONS=true` is set for that run; deployed rollbacks restore from backup (§11) instead.

## 7. Graceful shutdown

On `SIGTERM` each process stops accepting work and closes resources in order, bounded by `SHUTDOWN_GRACE_MS`:

- **api** (15 s): health turns `503`; HTTP server stops accepting connections and finishes in-flight requests; queue connection closes; DB pool drains.
- **worker** (30 s): workers stop taking new jobs and wait for in-flight jobs; jobs that cannot finish are retried later (BullMQ lock expiry + `job_runs` idempotency make this safe).
- **scheduler** (10 s): closes queues and Redis.

Dockerfiles use exec-form `CMD ["node", …]` so Node is PID 1 and receives the signal directly. Configure the service's draining/teardown period in Railway to be at least the grace period: Railway's default is **0 seconds** (SIGKILL right after SIGTERM), which skips all of the above. Suggested: api 20 s, worker 35 s, scheduler 15 s, web 10 s, plus a short overlap (about 10 s) on api and web.

**No volumes on app services.** Railway never runs two deployments of a service that has a volume attached, so every redeploy of such a service stops the old one first and drops requests. Volumes belong on `postgres` and `redis` only.

## 8. Object storage

- Use a private bucket. Allow `PUT` with the `content-type` header from the web origin in the bucket's CORS policy.
- The API signs `content-type` and `content-length` into each presigned URL (5-minute default) and verifies the stored object on `/complete`.
- TODO(provider-config): lifecycle rules for abandoned `pending` uploads; malware scanning before media is used.

## 9. PostgreSQL and Redis configuration

**PostgreSQL**
- PostGIS 3.x on PostgreSQL 16 (matching CI and docker-compose).
- Volume-backed data directory (`PGDATA` set below the mount point).
- `DATABASE_POOL_MAX` × replicas must stay below `max_connections`.
- The API statement timeout is 15 s.

**Redis**
- BullMQ requires `maxmemory-policy noeviction`. Evicting keys silently loses jobs. Confirm the policy on your Redis service.
- Enable persistence (AOF) if available so queued jobs survive restarts; jobs are idempotent, so a replayed job is safe, but a lost job is not retried.

## 10. Rollback procedure

1. **Identify** the bad deployment and whether it included a migration (`schema_migrations` table / PR diff of `packages/db/migrations`).
2. **No migration in the release:** redeploy the previous successful deployment of each affected service from the Railway dashboard. Roll back `web` and `api` together if the API contract changed.
3. **Migration in the release, backwards-compatible (expand-only):** roll back the application services as in step 2; leave the schema in place. Ship a follow-up fix.
4. **Migration in the release, not backwards-compatible:** pause the worker and scheduler (scale to 0) to stop writes from jobs, put the API into maintenance (or scale to 0), restore the database from the pre-deploy backup (§11), redeploy the previous version of every service, then scale back up.
5. **Contracts:** contracts are immutable. If a contract bug is found, the pauser pauses it, and a new contract is deployed after review; the indexer is pointed at the new address via `CHAIN_INDEX_CONTRACTS`.
6. Record the incident and the audit-event range affected.

## 11. Backup and restore checklist

Railway's own backup features vary by service type and plan; verify what is enabled for your volume before relying on it, and keep an independent logical backup.

- [ ] Daily `pg_dump --format=custom` of production to storage **outside** the Railway project, encrypted, with retention that matches your legal requirements.
- [ ] An extra backup immediately before every deployment that contains a migration.
- [ ] Back up object storage (versioning or replication) — boundaries' evidence documents live there.
- [ ] Redis does not need backup for correctness: jobs are re-creatable (pending-boundary sweep, scheduled jobs); but note in-flight jobs at restore time.
- [ ] Store contract addresses, deployment blocks and ABIs with the backup.
- [ ] **Monthly restore drill** into a scratch environment:
  1. create an empty PostGIS database;
  2. `pg_restore --no-owner --role=<db user> -d <url> backup.dump`;
  3. run `node dist/migrate.js` (should report "already up to date");
  4. run the integration test suite against it, or at least `SELECT count(*)` on core tables and a cross-tenant RLS check;
  5. record time-to-restore.
- [ ] Document who can access backups; access is audited outside this application.
