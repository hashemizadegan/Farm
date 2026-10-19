# Railway

The environment definition lives in [`.railway/railway.ts`](../../.railway/railway.ts) (Railway Infrastructure as Code, which the Railway CLI looks for at the repository root). The full runbook — services, variables, health checks, migrations, graceful shutdown, staging/production separation, rollback and backup/restore — is in [`docs/deployment-railway.md`](../../docs/deployment-railway.md).

Every service builds the root `Dockerfile`, which picks the app from the Railway service name (`RAILWAY_SERVICE_NAME`). Name the services exactly `web`, `api`, `worker` and `scheduler`, or set a service variable `APP=<name>`. No Dockerfile path setting is needed.

Per-service settings, in case you configure services in the dashboard instead:

| Service | Root directory | Builds | Pre-deploy | Health check path |
| --- | --- | --- | --- | --- |
| web | `/` | root `Dockerfile`, app `web` | — | `/offline` |
| api | `/` | root `Dockerfile`, app `api` | `node dist/migrate.js` | `/readyz` |
| worker | `/` | root `Dockerfile`, app `worker` | — | `/readyz` |
| scheduler | `/` | root `Dockerfile`, app `scheduler` | — | `/readyz` |

Watch paths (to avoid rebuilding every service on every commit), set in the service settings:

- web: `apps/web/**`, `packages/{ui,map-scene,domain,contracts}/**`
- api: `apps/api/**`, `packages/{config,db,domain,contracts,map-scene,observability}/**`
- worker: `apps/worker/**`, `packages/{config,db,domain,observability}/**`
- scheduler: `apps/scheduler/**`, `packages/{config,domain,observability}/**`

Also include `pnpm-lock.yaml` and `Dockerfile` in each list.
