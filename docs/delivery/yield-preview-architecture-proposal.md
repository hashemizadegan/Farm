# Isolated yield preview: architecture proposal (not provisioned)

**Status:** proposal only. **Nothing has been provisioned.** Prerequisites 1, 2, 5 and 9 below are not met.

**Goal:** show the simulation-only `/yield` operator pages on development data at a protected URL, completely
separate from the live Railway project.

## Hard boundaries

- A **new Railway project**, for example `metafarm-yield-preview`.
  - **Not** `melodious-liberation`.
  - Not a new environment inside it: an environment there shares the project's settings, members and
    references to the live services.
- No connection of any kind to the production PostgreSQL, Redis or `uploads` bucket. No variable references
  across projects.
- No wallet, signer, RPC, DAS or TRON variables at all:
  - `RWA_*` stays unset;
  - `TWIN_OWNERSHIP_INDEX_ENABLED=false`;
  - `RWA_MAINNET_ENABLED` stays unset.
- The worker and scheduler are not deployed. The preview needs neither, and the worker deploy hold (#45)
  concerns the live project anyway.

## Services (minimum)

| Service | Source | Notes |
|---|---|---|
| postgres | image `postgis/postgis:16-3.4`, new volume | Private network only, no TCP proxy. New password, set in the dashboard. |
| redis | Railway Redis | The API's queue and readiness check need it. Private only. |
| api | GitHub `hashemizadegan/Farm`, the preview branch (see below), root `Dockerfile`, `APP=api` | Pre-deploy `node dist/migrate.js` against the preview database only. Health check `/readyz`. |
| web | Same branch, `APP=web` | Health check **`/healthz`** (the access gate refuses `/offline`). |
| seed-runner (one-off) | Same branch, `APP=seed-runner` | Runs once after the migrations; see Data. Restart policy never; no domain. |

**Preview branch:** `preview/yield-simulation` (draft #99, base #96), together with its add-ons #100 (R1) and #101 (seed runner), merged into it before any deployment.
- It is #96 with #97 (lockfile) and #98 (access gate) merged in, using merge commits.
- Its lockfile was regenerated for this tree on a GitHub runner (pnpm 10.12.1; frozen reinstall succeeded).
- Re-generate it whenever a `package.json` on the branch changes.

## Variables (names only; values set in the preview project's variables, never committed)

- **api:**
  - `APP=api`, `APP_ENV=development`, `HOST=::`, `LOG_LEVEL=info`, `QUEUE_PREFIX=preview`;
  - `DATABASE_URL` (a reference to the preview Postgres), `DATABASE_SSL=false` on the private network, `REDIS_URL`;
  - `AUTH_PROVIDER=dev`, `DEV_AUTH_SECRET` (new, ≥ 32 characters, used only here);
  - `CORS_ORIGINS` (the preview web origin only);
  - `STORAGE_DRIVER=memory`. Development allows it; no bucket is needed.
  - `PREVIEW_ACCESS_GATE=true`;
  - `YIELD_WORKFLOW_ENABLED=true`, `YIELD_CLAIM_INTENTS_ENABLED=true`;
  - left **unset**: `PARTY_LINKS_ENABLED`, `HOLDER_YIELD_ENABLED`.
- **web:**
  - `APP=web`, `APP_ENV=development`;
  - `NEXT_PUBLIC_API_URL` (the preview API domain);
  - `NEXT_PUBLIC_YIELD_PAGES_ENABLED=true`;
  - `PREVIEW_ACCESS_GATE=true`, `PREVIEW_ACCESS_PASSWORD` (new, ≥ 24 characters).

`APP_ENV=development` is one of the values the existing guards explicitly accept for these switches and for the
seed. No guard is changed, and no `preview` value is added. The development configuration is what makes the
access gate mandatory.

## Data: seed runner (recommended approach; #101)

**Decision:** a separate one-off container, the `Dockerfile` target `app-seed-runner`.

Alternatives not chosen:
- Compiling the seeds into `dist` would put seed tooling into the production API image.
- CI-produced seed artifacts would add a new import path into the database.

The runner keeps the existing seeds and their guards, and the production images stay unchanged.

The runner refuses, with exit 1, unless all three hold:
1. `APP_ENV` is `development` or `test`, checked before connecting;
2. the database holds no workspace the development seed did not create (`demo`, `other`) and no user from a
   real identity issuer (anything but `dev`);
3. migrations are applied through 0029.

It then runs `@metafarm/db seed` and `seed:yield`. Both are idempotent, and the second keeps its own APP_ENV
guard. It mints no tokens and prints no secret. CI builds the image and checks the refusals (#101).

**Where and how it runs** (preview project only, after the API's pre-deploy migrations succeeded):

| Step | Where | Command / setting |
|---|---|---|
| 1 | Preview project → new service `seed-runner` | Source: the preview branch. Variable `APP=seed-runner` selects the target. Restart policy: **never**. No domain, no health check. |
| 2 | Its variables (names only) | `APP_ENV=development`, `DATABASE_URL` (reference to the **preview** Postgres), `REDIS_URL` (preview Redis), `DEV_AUTH_SECRET` (reference to the preview API's value) |
| 3 | Deploy once | Default command: `node --import tsx src/scripts/preview-seed-runner.ts` (in `/repo/apps/api`). Expected log: `checks passed … migrations through 0029_…`, the seeds' output, `[preview-seed] done`. |
| 4 | Afterwards | Remove the service, or leave it stopped. A re-run is idempotent ("already seeded"). |

The same runner works from a workstation against a database the operator can reach:
`APP_ENV=development DATABASE_URL=… DEV_AUTH_SECRET=… pnpm --filter @metafarm/api preview-seed`.
This is not recommended for the preview, because it needs a public TCP proxy on the preview database.

Expected result:
- Q1 and Q2 published, with unsigned simulation intents;
- Q3 frozen and awaiting approval (`under_review`).

Dev users: `dev-user`, `dev-yield-preparer` and `dev-yield-auditor`. These subjects exist only in the preview
database, under the `dev` issuer. They cannot match a production identity, which uses OIDC and another database.

## Access

- The browser gets HTTP Basic for the web origin (user `preview`; password = the preview
  `PREVIEW_ACCESS_PASSWORD`, shared out of band).
- **Dev tokens** are minted by the operator **on their own workstation**. `dev-token` only signs a JWT; it needs
  no database and no platform runtime, so no token ever appears in platform logs:
  `APP_ENV=development DEV_AUTH_SECRET=<preview secret> pnpm --filter @metafarm/api dev-token dev-user`.
  The token is valid for 8 hours; paste it on the sign-in page. The command refuses staging and production.
- Unauthenticated API requests get 401, except `/healthz`, `/readyz` and CORS preflights.

## Verification after deploy

Before each Railway action, record and check:
- the project is not `melodious-liberation`;
- the environment belongs to the new project;
- the database is the newly created one.

Then check:
- API `/healthz` and `/readyz`, and web `/healthz`;
- the migration version is 0029;
- **gate:**
  - web without credentials → 401, assets included;
  - API without a token → 401.
- `/yield`:
  - the D-39 banner, verbatim;
  - three cycles with Simulation badges;
  - Q1 and Q2 Published, Q3 Awaiting independent review / Frozen;
  - Q2 four-eyes (prepared by `dev-yield-preparer`, approved by `dev-user`, Separated), the dossier, the
    carry-in from Q1 and the intents table;
  - Q3 with no intents;
  - no signing or submission action anywhere;
  - no console or hydration errors.
- Desktop and mobile screenshots, using the existing Playwright spec pointed at the preview URL with the Basic
  credentials.

## Prerequisites (checked 2026-10-22)

| # | Prerequisite | State |
|---|---|---|
| 1 | Security review of Y0, Y5, Y7 and Y12 complete | **Not met.** Review material ready; no sign-off recorded. |
| 2 | Explicit security sign-off on migrations 0026–0029 | **Not met.** |
| 3 | Access gate implemented and tested | **Met in code.** #98 has automated tests in CI and is merged into the preview branch (#99). It has not been exercised on a deployed preview, because there is none. |
| 4 | Preview branch builds from a lockfile | **Met in code.** #99 carries its own lockfile; see #99's CI for the image builds. |
| 5 | Preview credentials available without committing them | **Not met.** `DEV_AUTH_SECRET` and `PREVIEW_ACCESS_PASSWORD` must be created in the new project's variables by the owner, or by Claude after approval. The seed and token method is settled: seed runner (#101) and offline `dev-token`. |
| 6 | Preview database isolated from production | Design only (a new project). |
| 7 | Dev auth cannot impersonate a production user | **Met by design.** Separate database; `dev` issuer versus OIDC; dev auth is refused in staging and production. |
| 8 | Seed refuses staging and production | **Met.** The guard is in the code and refuses before connecting. |
| 9 | The integration branch and its migrations are approved for preview use | **Not met.** |

Provisioning stays blocked until items 1, 2, 5 and 9 are explicitly satisfied.
