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

**Preview branch:** `preview/yield-simulation` (draft #99, base #96).
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

## Data

1. Run the migrations through 0029 on the **new** database (the API pre-deploy step).
2. Run `pnpm db:seed` (demo workspace), then `pnpm seed:yield`. **Open point:** the API runtime image contains
   only `dist` and production dependencies. These seeds and `dev-token` are `tsx` scripts over `src`, so they
   cannot run inside the deployed API service. Choose one of:
   - a one-off job built from the `Dockerfile`'s `deps` stage, with the preview variables;
   - running them from a workstation through a **temporary** TCP proxy on the preview database, removed
     afterwards.

   Either way, run the seeds against the preview database only.
3. The seed's own guard (`APP_ENV` development or test) is the second check, after the project check.

Expected result:
- Q1 and Q2 published, with unsigned simulation intents;
- Q3 frozen and awaiting approval.

Dev users: `dev-user`, `dev-yield-preparer` and `dev-yield-auditor`. These subjects exist only in the preview
database, under the `dev` issuer. They cannot match a production identity, which uses OIDC and another database.

## Access

- The browser gets HTTP Basic for the web origin (user `preview`).
- The API admits only bearer tokens minted with the preview `DEV_AUTH_SECRET`
  (`pnpm --filter @metafarm/api dev-token dev-user`, run from the same one-off job or workstation as the seed).
  The operator pastes the token on the sign-in page.
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
| 5 | Preview credentials available without committing them | **Not met.** They must be created in the new project by the owner, or by Claude after approval. A way to run the seed and `dev-token` (see Data) must also be chosen. |
| 6 | Preview database isolated from production | Design only (a new project). |
| 7 | Dev auth cannot impersonate a production user | **Met by design.** Separate database; `dev` issuer versus OIDC; dev auth is refused in staging and production. |
| 8 | Seed refuses staging and production | **Met.** The guard is in the code and refuses before connecting. |
| 9 | The integration branch and its migrations are approved for preview use | **Not met.** |

Provisioning stays blocked until items 1, 2, 5 and 9 are explicitly satisfied.
