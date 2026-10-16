# Architecture

```
 Browser ──HTTPS──► web (Next.js)            static UI, CSP with nonce
    │
    ├──HTTPS──► api (Fastify) ──► PostgreSQL + PostGIS   (RLS, append-only audit)
    │              │         └──► Redis (BullMQ)  ◄── scheduler (job schedulers)
    │              │                    │
    │              │                    ▼
    │              │                 worker ──► PostGIS validation, observation
    │              │                    │       normalisation, alerts, chain indexing
    │              │                    └──► RPC provider (optional, fixed URL)
    └──PUT (presigned)──► object storage (S3-compatible, private)
```

## Packages

| Package | Role | Runtime |
| --- | --- | --- |
| `packages/domain` | Pure rules: provenance, roles, geometry validation, scenarios, NFT metadata rules, wallet messages, observations/alerts, job contracts. `./server` adds Node-only crypto (webhooks, nonces). | Browser + Node |
| `packages/db` | Pool, `withTenant`/`withSystem`, SQL migrations, tenant-scoped repositories | Node |
| `packages/contracts` | OpenAPI 3.1 spec, NFT metadata JSON Schema, generated types, typed client | Both |
| `packages/map-scene` | `core`: local frame, deterministic scene builder, quality presets, WebGL detection. `react`: lazy R3F scene + DOM alternative. `map`: MapLibre adapter, mock style, Cesium adapter | Browser (core also Node) |
| `packages/ui` | Accessible primitives, live-region announcer, base CSS | Browser |
| `packages/config` | Zod-validated env per service, with production guards | Node |
| `packages/observability` | pino logger with redaction, graceful shutdown, health server | Node |

Workspace packages export TypeScript source. Node apps are bundled with tsup (workspace code inlined, third-party deps external); Next.js transpiles them via `transpilePackages`.

## Request path (tenant-scoped)

1. Bearer token → `AuthProvider.verify` (OIDC or dev) → upsert `users` by `(issuer, subject)`.
2. `app.inTenant(req, permission, fn)`: membership lookup → 404 if none → permission check → 403 if denied (audited).
3. `withTenant`: `BEGIN; SET LOCAL ROLE metafarm_app; set_config('app.tenant_id', …, true)` → repository calls (explicit `tenant_id` filters) → `COMMIT`.
4. Side effects that need background work are enqueued **after** commit with deterministic job ids. A sweep re-queues boundaries left `pending` if an enqueue was lost.

## Jobs

| Queue | Producer | Idempotency key | Notes |
| --- | --- | --- | --- |
| `gis-validation` | API on boundary submit; sweep | `gis:{tenant}:{boundaryVersion}` | `ST_IsValidDetail`, SRID, geodesic area, overlaps |
| `imagery-ingestion` | (not scheduled until a provider exists) | `imagery:{tenant}:{farm}:{from}:{to}` | Default provider `none` ingests nothing |
| `observation-normalization` | API on observation submit | `obs:{tenant}:{raw}` | Unique `raw_id` makes inserts idempotent |
| `alert-evaluation` | scheduler sweep → per-farm jobs | `alerts:{tenant}:{farm}:{bucket}` | Alerts de-duplicated by evidence set |
| `chain-event-indexing` | scheduler | `chain:{chain}:{contract}:{from}-latest:{jobId}` | Confirmations, reorg rewind, upsert on `(tx, logIndex)` |
| `dead-letter` | worker on final failure | — | Kept for inspection/manual replay |

Every handler runs inside `wrapHandler`: claim in `job_runs` (skip if completed) → run → mark completed, or record failure; non-retryable errors discard the job; the final attempt dead-letters. Retries use BullMQ exponential backoff.

## 3D scene

- Coordinates: metres in a local east/up/south frame around the farm origin (avoids float32 jitter).
- Deterministic: seed = FNV-1a(farmId); PRNG values are consumed even for skipped positions; output rounded to millimetres; stable ids `parcel-slug:r{row}c{col}`. Fixture: `packages/map-scene/src/core/__fixtures__`.
- Rendering: lazy-loaded canvas, one `InstancedMesh` per asset, `frameloop="demand"`, DPR capped per quality preset, deterministic thinning above the preset's instance cap, explicit disposal of imperatively created GPU resources, context-loss handling.
- Globe/terrain/3D Tiles: optional Cesium adapter behind `CesiumAdapter`; disabled by default, no paid provider required.

## Provider integrations (all behind interfaces)

| Concern | Interface | Default |
| --- | --- | --- |
| Identity | `AuthProvider` | `dev` locally, `oidc` when deployed |
| Object storage | `ObjectStorage` | S3-compatible; in-memory for tests |
| Basemap | `MapAdapter` + `BasemapConfig` | Offline mock style (graticule, clearly labelled) |
| Globe | `CesiumAdapter` | Disabled |
| Imagery | `ImageryProvider` | `none` |
| Chain | `ChainReader` | viem over `CHAIN_RPC_URL`; skipped if unset |
| Queue | `JobProducer` | BullMQ; in-memory for tests |
