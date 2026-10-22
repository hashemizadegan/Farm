# Isolated yield preview: operator runbook

The simulation-only `/yield` operator pages, deployed to a **separate Railway project**, private behind the
preview access gate.

**Do not start until the security review package records the preview-only approval:**
`docs/delivery/yield-security-review-package-2026-10-22.md` §B on the plan branch. Production approval does not
exist.

Hard boundaries:
- Never link or apply anything to `melodious-liberation`, the live project. The preview IaC file refuses it.
- No worker or scheduler is deployed.
- No signer, RPC, DAS, TRON or mainnet variable is set.
- `PARTY_LINKS_ENABLED` and `HOLDER_YIELD_ENABLED` stay unset.
- Secrets live only in the preview project's variables. `.env.preview.example` lists names and placeholders.

Files:
- `infra/railway/preview/railway.ts`: services and variables.
- `.env.preview.example`: every variable, who generates it, who consumes it.
- `Dockerfile` target `app-seed-runner`: the one-off seed container.
- `docs/preview-access-gate.md`: the gate.

## 1. Local validation (before any deployment)

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test:unit
docker compose up -d                          # PostGIS, Redis, MinIO
export DATABASE_URL=postgres://metafarm:metafarm@localhost:5432/metafarm REDIS_URL=redis://localhost:6379
pnpm test:integration                         # includes migration lifecycle 0019–0029 and the seed runner end to end
pnpm db:migrate && pnpm db:seed
pnpm dev:yield                                # local stack with the yield switches (APP_ENV=development)
pnpm seed:yield                               # simulation cycles (idempotent)
```

Full e2e, including the gate in a real server, as CI runs it:

```bash
pnpm --filter @metafarm/web build
E2E_GATED_WEB_URL=http://localhost:3101 E2E_PREVIEW_ACCESS_PASSWORD=local-only-preview-password-0123 \
  CORS_ORIGINS=http://localhost:3000,http://localhost:3101 NEXT_PUBLIC_YIELD_PAGES_ENABLED=true \
  YIELD_WORKFLOW_ENABLED=true YIELD_CLAIM_INTENTS_ENABLED=true CI=1 pnpm test:e2e
```

## 2. Create and configure the preview project

1. **Create the project.** Its name **must** start with `metafarm-yield-preview`:

   ```bash
   railway init --name metafarm-yield-preview
   railway link            # select metafarm-yield-preview; confirm the prompt shows that project
   railway status          # check: project metafarm-yield-preview, NOT melodious-liberation
   ```

2. **Plan.** Read-only. It fails immediately if the linked project is not a preview project:

   ```bash
   railway config plan --file infra/railway/preview/railway.ts
   ```

   Expected: create `postgres`, the `postgres-data` volume, `redis`, `api`, `web` and `seed-runner`. **Nothing**
   is deleted.

3. **Apply.** The services are created; the GitHub source deploys `preview/yield-simulation`:

   ```bash
   railway config apply --file infra/railway/preview/railway.ts
   ```

4. **Set the operator-generated secrets.** The values never leave the preview project; do not echo or paste them
   anywhere else:

   ```bash
   railway variables --service postgres --set "POSTGRES_PASSWORD=$(openssl rand -hex 32)"
   railway variables --service api      --set "DEV_AUTH_SECRET=$(openssl rand -base64 48)"
   railway variables --service web      --set "PREVIEW_ACCESS_PASSWORD=$(openssl rand -base64 32)"
   ```

   - Give the seed runner the same `DEV_AUTH_SECRET` as the API: a reference variable
     `${{api.DEV_AUTH_SECRET}}` in the seed-runner service.
   - Keep `DEV_AUTH_SECRET` and `PREVIEW_ACCESS_PASSWORD` in your password manager. You need them for tokens and
     smoke tests.

5. **Domains and origins.** Generate a domain for `api` and for `web` (`railway domain --service api`, then
   `--service web`). Then set:
   - `api`: `CORS_ORIGINS=https://<web domain>`;
   - `web`: `NEXT_PUBLIC_API_URL=https://<api domain>` (a build arg: redeploy web after setting it).
6. **Seed-runner settings** (dashboard → seed-runner → Settings):
   - Restart policy: **Never**;
   - no domain, no health check.

## 3. Migrations

The API's pre-deploy step runs `node dist/migrate.js` on the preview database only, through 0029. Check the API
deploy log for `[migrate] applied 0029_yield_claim_intent_batches`, or "already up to date" on later deploys.

## 4. One-time seeding

Deploy the `seed-runner` service once, after the API is healthy. The runner refuses unless all of these hold:
- `APP_ENV` is development or test;
- the database has no workspace other than the dev seed's;
- there is no real (non-`dev`) sign-in;
- migrations are at 0029 or later.

Expected log:

```text
[preview-seed] checks passed (APP_ENV=development, migrations through 0029_yield_claim_intent_batches, workspaces: 0)
[preview-seed] running demo workspace (@metafarm/db seed)
[preview-seed] running simulation yield cycles (@metafarm/api seed:yield)
[seed:yield] 2026-01-01: published, set …, N unsigned intent(s)
[seed:yield] 2026-04-01: published, set …
[seed:yield] 2026-07-01: calculated and under review (awaiting approval), set …
[preview-seed] done
```

A re-run reports "already seeded" and changes nothing.

## 5. Access

- **Browser:** open `https://<web domain>`. The browser asks for HTTP Basic credentials: user `preview`, password
  `PREVIEW_ACCESS_PASSWORD`.
- **Sign-in token:** minted offline on your workstation. It needs no database or platform access, and nothing
  reaches the platform logs:

  ```bash
  APP_ENV=development DEV_AUTH_SECRET='<preview DEV_AUTH_SECRET>' pnpm --filter @metafarm/api dev-token dev-user
  ```

  Paste it on the sign-in page; it is valid for 8 hours. Subjects: `dev-user` (owner, approver),
  `dev-yield-preparer` (manager), `dev-yield-auditor` (verifier).

## 6. Smoke tests against the preview

```bash
E2E_REMOTE=1 E2E_WEB_URL=https://<web domain> E2E_API_URL=https://<api domain> \
E2E_PREVIEW_ACCESS_PASSWORD='<preview PREVIEW_ACCESS_PASSWORD>' DEV_AUTH_SECRET='<preview DEV_AUTH_SECRET>' \
NEXT_PUBLIC_YIELD_PAGES_ENABLED=true \
  pnpm --filter @metafarm/e2e exec playwright test preview-gate.spec.ts yield-operator.spec.ts
```

The suite checks:
- **Gate:** pages, manifest and assets get 401 without credentials; wrong credentials get 401; `/healthz` 200.
- **API:** unauthenticated requests get 401, except health checks.
- **Authenticated:** sign-in and `/yield` with the D-39 banner; Q1 and Q2 published, Q3 awaiting review;
  four-eyes, dossier, carry-in and the unsigned intents table.
- **Clean pages:** no console or hydration errors.

Screenshots go to `tests/yield-screenshots/`; traces of failures go to `tests/test-results/`. Run only these two
specs remotely: the rest of the suite creates data.

## 7. Rollback and teardown

| Situation | Action |
|---|---|
| A bad web or api deploy | Dashboard → service → Deployments → previous deployment → **Rollback** (preview project only). |
| A bad migration in the preview | The preview holds simulation data only. Delete the `postgres` service and its volume, re-apply (§2.3, §2.4), and re-seed (§4). Do not use down migrations on a shared database. |
| A leaked `PREVIEW_ACCESS_PASSWORD` or `DEV_AUTH_SECRET` | Set a new value (§2.4) and redeploy that service. Tokens minted with the old secret stop working. |
| End of the preview | Delete the whole `metafarm-yield-preview` project. Nothing else depends on it. |

The live project, its database (migration 0018) and the worker deploy hold (#45) are never part of these steps.
