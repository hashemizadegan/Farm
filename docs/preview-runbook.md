# Isolated preview: operator runbook

The simulation-only `/yield` operator pages and the **farm operations journey** (farm → current conditions →
observation → source → integration), deployed to a **separate Railway project**, private behind the preview access
gate.

**Do not start until the security review package records the preview-only approval:**
`docs/delivery/yield-security-review-package-2026-10-22.md` §B on the plan branch. Production approval does not
exist.

Hard boundaries:
- Never link or apply anything to `melodious-liberation`, the live project. The preview IaC file refuses it.
- A worker (observation normalization, realtime announcements) and a scheduler (realtime retention, alert sweep) run
  in the preview, against its own database and redis only. **This extends the scope the yield preview approval
  described ("no worker or scheduler"): the reviewer must record the extended preview-only approval in §B before
  this IaC is applied.**
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
pnpm test:integration                         # includes migration lifecycle 0019–0032 and the seed runner end to end
pnpm db:migrate && pnpm db:seed
# .env: INTEGRATION_SECRET_KEY=<openssl rand -hex 32>  (local only; without it the farm seed skips the integration)
pnpm dev:preview                              # local stack as the preview runs it: yield, realtime, integrations
pnpm seed:yield                               # simulation cycles (idempotent)
pnpm seed:farm-ops                            # the farm operations journey (idempotent)
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

2. **Plan.** Read-only. It fails immediately if the linked project is not a preview project. **Always pass
   `--file`:** without it the CLI picks up `.railway/railway.ts`, which describes the live project.

   ```bash
   railway config plan --file infra/railway/preview/railway.ts
   ```

   Expected: create `postgres`, the `postgres-data` volume, `redis`, `api`, `web` and `seed-runner`. **Nothing**
   is deleted.

3. **Apply.** The services are created; the GitHub source deploys `preview/yield-simulation`. That branch must
   already contain #100, #101 and #103 (merged by the owner; check `git log origin/preview/yield-simulation`).

   ```bash
   railway config apply --file infra/railway/preview/railway.ts
   ```

4. **Set the operator-generated secrets.** The values never leave the preview project; do not echo or paste them
   anywhere else:

   ```bash
   railway variables --service postgres --set "POSTGRES_PASSWORD=$(openssl rand -hex 32)"
   railway variables --service api      --set "DEV_AUTH_SECRET=$(openssl rand -base64 48)"
   railway variables --service web      --set "PREVIEW_ACCESS_PASSWORD=$(openssl rand -base64 32)"
   railway variables --service api      --set "INTEGRATION_SECRET_KEY=$(openssl rand -hex 32)"
   ```

   - The seed runner reads the API's `DEV_AUTH_SECRET` and `INTEGRATION_SECRET_KEY` by reference (declared in the
     IaC file); nothing to set.
   - The first deployments made by `apply` start **before** these values exist, so they fail closed: the API refuses
     to start without `DEV_AUTH_SECRET`, and the seed runner refuses (no secret, or migrations not yet at 0029).
     That is expected. Redeploy `api`, then `web` (after §2.5), then the seed runner (§4).
   - Keep `DEV_AUTH_SECRET` and `PREVIEW_ACCESS_PASSWORD` in your password manager. You need them for tokens and
     smoke tests.

5. **Domains and origins.** Generate a domain for `api` and for `web` (`railway domain --service api`, then
   `--service web`). Then set:
   - `api`: `CORS_ORIGINS=https://<web domain>`;
   - `web`: `NEXT_PUBLIC_API_URL=https://<api domain>` and `NEXT_PUBLIC_REALTIME_URL=wss://<api domain>/v1/realtime`
     (build args: redeploy web after setting them). The web build refuses a realtime URL that is not exactly the
     channel URL over wss, or that carries a token or query.
6. **Seed-runner settings** (dashboard → seed-runner → Settings):
   - Restart policy: **Never**;
   - no domain, no health check.

## 3. Migrations

The API's pre-deploy step runs `node dist/migrate.js` on the preview database only, through 0032. Check the API
deploy log for `[migrate] applied 0032_realtime_retention_horizons`, or "already up to date" on later deploys.

## 4. One-time seeding

Deploy the `seed-runner` service once, after the API is healthy. The runner refuses unless all of these hold:
- `APP_ENV` is development or test;
- the database has no workspace other than the dev seed's;
- there is no real (non-`dev`) sign-in;
- migrations are at 0032 or later.

Expected log:

```text
[preview-seed] checks passed (APP_ENV=development, migrations through 0032_realtime_retention_horizons, workspaces: 0)
[preview-seed] running demo workspace (@metafarm/db seed)
[preview-seed] running simulation yield cycles (@metafarm/api seed:yield)
[seed:yield] 2026-01-01: published, set …, N unsigned intent(s)
[seed:yield] 2026-04-01: published, set …
[seed:yield] 2026-07-01: calculated and under review (awaiting approval), set …
[preview-seed] running farm operations journey (@metafarm/api seed:farm-ops)
[seed:farm-ops] integration "Simulated field feed" registered; 2 signed events accepted (its secret is not kept: …)
[seed:farm-ops] North orchard (simulation) (…): 6 observations normalized; sensors — …: online; …: silent; …
[preview-seed] done
```

Without `INTEGRATION_SECRET_KEY` the runner prints a note, and the farm seed reports that it skipped the integration
(probe A then reports through its device token). Set the key and seed a fresh database to include it.

A re-run reports "already seeded" and changes nothing.

## 5. Access

- **Browser:** open `https://<web domain>`. The browser asks for HTTP Basic credentials: user `preview`, password
  `PREVIEW_ACCESS_PASSWORD`.
- **Sign-in token:** minted offline on your workstation. It needs no database or platform access, and nothing
  reaches the platform logs:

  ```bash
  APP_ENV=development DEV_AUTH_SECRET='<preview DEV_AUTH_SECRET>' pnpm --filter @metafarm/api dev-token dev-user
  ```

  Without a checkout (any machine with Node.js 18+; nothing is installed, nothing is sent anywhere). Paste the value
  at the hidden prompt; it is not echoed or kept in the shell history:

  ```bash
  read -rs DEV_AUTH_SECRET && export DEV_AUTH_SECRET && node -e 'const c=require("crypto"),b=x=>Buffer.from(JSON.stringify(x)).toString("base64url"),n=Math.floor(Date.now()/1000),h=b({alg:"HS256"})+"."+b({name:"dev-user",iss:"dev",aud:"metafarm-dev",sub:"dev-user",iat:n,exp:n+28800});console.log(h+"."+c.createHmac("sha256",process.env.DEV_AUTH_SECRET).update(h).digest("base64url"))'; unset DEV_AUTH_SECRET
  ```

  Both values live only in the preview project: Railway dashboard → `metafarm-yield-preview` → `web` → Variables →
  `PREVIEW_ACCESS_PASSWORD`; `api` → Variables → `DEV_AUTH_SECRET`.

  Paste it on the sign-in page; it is valid for 8 hours. Subjects: `dev-user` (owner, approver),
  `dev-yield-preparer` (manager), `dev-yield-auditor` (verifier).

## 6. Smoke tests against the preview

```bash
E2E_REMOTE=1 E2E_WEB_URL=https://<web domain> E2E_API_URL=https://<api domain> \
E2E_PREVIEW_ACCESS_PASSWORD='<preview PREVIEW_ACCESS_PASSWORD>' DEV_AUTH_SECRET='<preview DEV_AUTH_SECRET>' \
  pnpm test:e2e
```

The suite checks:
- **Gate:** pages, manifest and assets get 401 without credentials; wrong credentials get 401; `/healthz` 200.
- **API:** unauthenticated requests get 401, except health checks.
- **Authenticated:** sign-in and `/yield` with the D-39 banner; Q1 and Q2 published, Q3 awaiting review;
  four-eyes, dossier, carry-in and the unsigned intents table.
- **Clean pages:** no console or hydration errors.
- **Farm operations journey:** the seeded farm's current conditions in every freshness state, an integration
  observation's source, and the integration management page filtered to the farm.

**From inside the preview project** (no workstation, secrets never leave the project): create a temporary service
`acceptance-runner` from the same repo and branch with restart policy **Never** and these variables, deploy it once,
read its log, then delete the service:

```text
APP=acceptance
E2E_WEB_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
E2E_API_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}
E2E_PREVIEW_ACCESS_PASSWORD=${{web.PREVIEW_ACCESS_PASSWORD}}
DEV_AUTH_SECRET=${{api.DEV_AUTH_SECRET}}
```

In remote mode the config runs `preview-gate.spec.ts`, `yield-operator.spec.ts`, `preview-journey.spec.ts` (the
farm operations journey over the seeded data; it creates nothing) and `preview-live.spec.ts` (§8 step 7: registers its
own simulation feed, sends signed simulation readings for Soil probe A, checks the live update and the polling fallback,
then revokes that feed and checks the refusal; the seeded feed is untouched): the rest of the suite creates unrelated data. `E2E_REMOTE_ALL=1` overrides that deliberately.
Nothing is seeded from the workstation in remote mode. Screenshots go to `tests/yield-screenshots/`; traces, videos
and screenshots of failures go to `tests/test-results/` and the HTML report to `tests/playwright-report/`.

## 7. Rollback and teardown

| Situation | Action |
|---|---|
| A bad web or api deploy | Dashboard → service → Deployments → previous deployment → **Rollback** (preview project only). |
| A bad migration in the preview | The preview holds simulation data only. Delete the `postgres` service and its volume, re-apply (§2.3, §2.4), and re-seed (§4). Do not use down migrations on a shared database. |
| A leaked `PREVIEW_ACCESS_PASSWORD` or `DEV_AUTH_SECRET` | Set a new value (§2.4) and redeploy that service. Tokens minted with the old secret stop working. |
| End of the preview | Delete the whole `metafarm-yield-preview` project. Nothing else depends on it. |

The live project, its database (migration 0018) and the worker deploy hold (#45) are never part of these steps.

## 8. Acceptance walkthrough: farm operations

Prerequisites: §2–§4 done (worker and scheduler deployed, seed log as in §4), and you are signed in (§5) as
`dev-user` (owner: sees the integration controls). Everything shown is simulation data, labelled "(simulation)".

| Step | Where | Expected |
|---|---|---|
| 1. Sign in | `/sign-in` (after the HTTP Basic prompt) | Lands on the overview of "Demo Tenant" (the only workspace; the switcher shows it). |
| 2. Open the farm | nav **Farms** → **North orchard (simulation)** | Farm page with **Current conditions**. With the realtime URL set: "Live updates". |
| 3. Freshness | Current conditions → Sensors | Soil probe A: **Reporting** (latest soil moisture 23.4 and air temperature 18.2, with times); Soil probe B: **Silent** (last reading 3 days ago, allowance 60 minutes); Weather mast: **Waiting for first reading**; Rain gauge: **Disabled**. States are computed against the current time: probe A turns Silent 7 days after seeding. |
| 4. Observations | Current conditions → Latest observations, or **All observations** | Newest first, each with its time and provenance badge; a field note entered by a person. |
| 5. Inspect one | click "Soil moisture: 23.4 …" | Observation page: value as stored and as received, observed / received / recorded times, provenance "provider observation", **Source: Registered integration** — "Simulated field feed" (metafarm-simulation), provider event `simulation-2`, sensor Soil probe A. |
| 6. Manage the integration | **Manage this integration** | `/integrations?farmId=…`: "Showing the integrations that have delivered observations to North orchard (simulation)"; the feed is Active, with Rotate secret and Revoke. Also in the main nav: **Integrations** (admins and owners only). |
| 7. Send a live reading (optional) | **Rotate secret** → copy the secret (shown once; tick the acknowledgement) | Sign an event as the "How to sign events" text says and POST it to the shown URL; within seconds the farm page updates without a reload (the worker normalizes it, the realtime channel announces it). Revoke the feed afterwards if you want: further events are refused (403). |

Unresolved external dependencies for an operational preview: the preview-only approval in §B (extended to the
worker and scheduler), the preview project and its secrets (§2), and a preview branch containing this work
(`PREVIEW_BRANCH` in the IaC file; merging into it is the owner's decision).


## 9. Preview-only approval record (worker and scheduler)

Recorded before the worker and scheduler configuration was applied. **This is a preview-only approval given by the
owner; it is not a security sign-off and grants nothing for production.**

| Item | Value |
|---|---|
| Approved by | Repository owner (hashemizadegan), instruction of 2026-10-23: "Proceed to Railway now, but only for the isolated preview environment" |
| Scope | Isolated preview only. Extends the yield preview approval ("no worker or scheduler") to a worker and a scheduler that run against the preview's own PostGIS and Redis. |
| Railway project | `metafarm-yield-preview` (id `bb34f176-9bb2-4d4a-8b74-0b710554b84b`), environment `preview` (id `f4d7114d-2138-461f-9ee1-631412ec79fc`), workspace "hashemizadegan's Projects". Not `melodious-liberation` (id `79dfa6d8-…`). |
| Branch and commit | `preview/yield-simulation`, fast-forwarded from `1c9024e` to the head of draft PR #109, which contains #104 → #105 → #106 → #107 → #108 → #109 (the exact deployed commit is shown in each Railway deployment). |
| Services | `postgres` (postgis/postgis:16-3.4, volume `postgres-data`), `redis`, `api`, `web`, `worker`, `scheduler`, `seed-runner` (one-off); `acceptance-runner` (temporary, §6; deleted after the run). |
| Isolation | New project; its own database, redis, domains and secrets, generated for this project only and never copied from production. No reference crosses projects. Queue prefix `preview`. |
| Simulation-only restrictions | `APP_ENV=development`; access gate on (web HTTP Basic, API bearer-only); storage in memory; yield claim intents are unsigned simulations. No signer, RPC, DAS, TRON, Solana mainnet, bucket or OIDC variable; `PARTY_LINKS_ENABLED`, `HOLDER_YIELD_ENABLED` unset. Execution, signing and every real-money operation stay disabled. |
| Production | No change: `melodious-liberation` untouched, live database stays at 0018, worker deploy hold #45 stays in force, no PR merged (all drafts). |
