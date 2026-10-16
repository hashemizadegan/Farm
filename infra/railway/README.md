# Railway

The environment definition lives in [`.railway/railway.ts`](../../.railway/railway.ts) (Railway Infrastructure as Code, which the Railway CLI looks for at the repository root). The full runbook — services, variables, health checks, migrations, graceful shutdown, staging/production separation, rollback and backup/restore — is in [`docs/deployment-railway.md`](../../docs/deployment-railway.md).

Per-service build settings, in case you configure services in the dashboard instead:

| Service | Root directory | `RAILWAY_DOCKERFILE_PATH` | Pre-deploy | Health check path |
| --- | --- | --- | --- | --- |
| web | `/` | `apps/web/Dockerfile` | — | `/sign-in` |
| api | `/` | `apps/api/Dockerfile` | `node dist/migrate.js` | `/readyz` |
| worker | `/` | `apps/worker/Dockerfile` | — | `/healthz` |
| scheduler | `/` | `apps/scheduler/Dockerfile` | — | `/healthz` |

Watch paths (to avoid rebuilding every service on every commit), set in the service settings:

- web: `apps/web/**`, `packages/{ui,map-scene,domain,contracts}/**`
- api: `apps/api/**`, `packages/{config,db,domain,contracts,map-scene,observability}/**`
- worker: `apps/worker/**`, `packages/{config,db,domain,observability}/**`
- scheduler: `apps/scheduler/**`, `packages/{config,domain,observability}/**`

Also include `pnpm-lock.yaml` and the service's Dockerfile in each list.
