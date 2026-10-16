# Metafarm

Multi-tenant SaaS for planning farm projects: customers enter GPS coordinates or draw/import a boundary, configure a planting plan and simulated crop scenarios, record observations and alerts, and explore an **illustrative** 3D scene of the farm. Optional NFTs are digital collectibles or in-app utility only.

> **Read first:** [`docs/data-provenance-and-legal.md`](docs/data-provenance-and-legal.md). Boundaries are user-entered unless verified with evidence; 3D scenes are not surveys; scenarios are simulations, not income; NFTs do not convey land title, crop ownership, profit share or any promise of value. There is no fungible token, yield, revenue share or investment product in this codebase.

## Stack

TypeScript everywhere · Next.js App Router + React (web) · Fastify (API) · PostgreSQL 16 + PostGIS · Redis + BullMQ (worker, scheduler) · MapLibre GL JS (2D) · React Three Fiber / three.js (3D) · optional Cesium adapter · S3-compatible storage with presigned URLs · OpenAPI 3.1 with generated client types · Hardhat + OpenZeppelin v5 (ERC-721 / ERC-1155) · Vitest · Playwright · Docker · Railway · GitHub Actions.

## Repository layout

```
apps/web            Next.js dashboard (farm list, onboarding, coordinate entry, boundary review,
                    scenarios, observations, alerts, asset catalogue, 3D scene, disclosures)
apps/api            Fastify API: auth, tenant authorization, validation, signed uploads, audit
apps/worker         BullMQ consumers: GIS validation, imagery, observations, alerts, chain indexing
apps/scheduler      BullMQ job schedulers (alert sweep, chain indexing)
packages/contracts  openapi.yaml, nft-metadata.schema.json, generated types + typed client
packages/domain     Provenance, roles, geometry validation, scenarios, NFT rules, wallet auth, jobs
packages/db         Migrations (PostGIS, RLS), tenant-scoped repositories, migrate/seed scripts
packages/ui         Accessible components, live-region announcer, base styles
packages/map-scene  Local frame, deterministic scene builder, R3F scene, MapLibre + Cesium adapters
packages/config     Validated environment per service
packages/observability  Logger (with redaction), graceful shutdown, health server
contracts/nft       Solidity contracts + tests
infra/railway       Railway notes (IaC lives in .railway/railway.ts)
tests               Playwright end-to-end tests
docs                Architecture, API + curl, threat model, provenance/legal, accessibility, deployment
```

## Run locally

Requirements: Node 22.12+, pnpm 10 (`corepack enable`), Docker.

```bash
cp .env.example .env
pnpm install                 # also generates API types from openapi.yaml
pnpm infra:up                # PostGIS, Redis, MinIO (docker compose)
pnpm db:migrate
pnpm db:seed                 # demo tenant, dev users, procedural asset catalogue — no fake data
pnpm dev                     # web :3000, api :4000 (docs at /docs), worker :4100, scheduler :4200
```

Sign in at http://localhost:3000/sign-in with a development token:

```bash
pnpm --silent --filter @metafarm/api dev-token dev-user
```

After the first `pnpm install`, **commit `pnpm-lock.yaml`**; CI and the Dockerfiles then install with `--frozen-lockfile`.

## Tests

```bash
pnpm test:unit            # domain, scene fixtures, runner, API HTTP layer, UI components, contracts-vs-spec
pnpm test:integration     # needs DATABASE_URL (PostGIS) — RLS isolation, API authorization, jobs, reorgs
pnpm test:contracts       # Hardhat tests for the NFT contracts
pnpm --filter @metafarm/e2e install-browsers && pnpm test:e2e   # Playwright (starts api, worker, web)
pnpm lint && pnpm typecheck
```

| Area | Where |
| --- | --- |
| Geometry (invalid coordinates, self-intersection, vertex limits, rings, CRS, area, duplicates) | `packages/domain/src/geometry.test.ts` |
| Tenant isolation incl. RLS without filters | `packages/db/src/tenant-isolation.int.test.ts` |
| API authorization (404 cross-tenant, role 403s, uploads, wallet replay) | `apps/api/src/authz.int.test.ts` |
| Security baseline (headers, CORS, body limit, rate limit, webhooks) | `apps/api/src/app.test.ts` |
| Job idempotency, retries, dead-letter | `apps/worker/src/runner.test.ts`, `apps/worker/src/jobs.int.test.ts` |
| Deterministic 3D fixtures | `packages/map-scene/src/core/scene-builder.test.ts` + `__fixtures__/` |
| Contracts (roles, fixed supply, pause, no confiscation) | `contracts/nft/test/` |
| Accessibility and fallbacks | `packages/ui/src/components.test.tsx`, `tests/e2e/` |

## What is mocked or left for you

Everything external sits behind an interface (see [`docs/architecture.md`](docs/architecture.md)). Search for `TODO(provider-config)` and `TODO(legal-review)`:

- **Identity:** OIDC in both API and web (Authorization Code + PKCE in the browser); a development token provider when no OIDC provider is configured.
- **Basemap:** an offline placeholder style (background + graticule); set `NEXT_PUBLIC_MAP_STYLE_URL` for a real provider.
- **Imagery:** provider `none` (ingests nothing).
- **Globe/3D Tiles:** Cesium adapter disabled by default; no paid provider needed.
- **Webhook → tenant mapping** for sensor/provider events.
- **Upload scanning** (malware, EXIF stripping).
- **Legal text** in every jurisdiction you operate in.

## Deploy

Separate Railway services for web, API, worker and scheduler, plus PostGIS, Redis and object storage: see [`docs/deployment-railway.md`](docs/deployment-railway.md) and [`.railway/railway.ts`](.railway/railway.ts).

## Docs

- [Architecture](docs/architecture.md)
- [API reference and curl examples](docs/api.md)
- [Threat model](docs/threat-model.md)
- [Data provenance and legal disclosures](docs/data-provenance-and-legal.md)
- [Accessibility](docs/accessibility.md)
- [Deployment on Railway](docs/deployment-railway.md) · [step-by-step staging setup](docs/railway-staging-setup.md)
