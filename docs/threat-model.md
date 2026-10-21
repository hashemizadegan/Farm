# Threat model

Scope: the web app, API, worker, scheduler, PostgreSQL/PostGIS, Redis, object storage, the NFT contracts and the chain indexer. Method: for each threat, the asset at risk, how an attacker would try, the controls in this repository, and what remains for the operator.

Trust boundaries: **browser ↔ API** (untrusted input), **provider ↔ webhook endpoint** (untrusted until signature verified), **API/worker ↔ database** (trusted, but tenant-scoped), **worker ↔ RPC/imagery providers** (semi-trusted, fixed endpoints), **chain ↔ indexer** (public, eventually consistent).

---

## 1. Cross-tenant access

**Asset:** every tenant's farms, boundaries, observations, media, audit trail.
**Attacks:** guess or reuse IDs from another tenant (IDOR); call `/v1/tenants/{other}/…`; a code path that forgets the tenant filter; SQL injection to bypass filters.

**Controls**
- All tenant resources are under `/v1/tenants/{tenantId}/…`. `app.inTenant()` (apps/api/src/plugins/context.ts) authenticates, resolves the caller's membership, checks the role's permission, and only then opens a transaction.
- Non-members get **404**, not 403, so tenant/resource existence is not disclosed. Attempts are audited (`tenant.access_denied`).
- Every repository query filters on `tenant_id` explicitly, and repository functions take a `TenantTx` type that only `withTenant()` can produce.
- **Row-level security** is the second wall: each tenant transaction runs `SET LOCAL ROLE metafarm_app` (no `BYPASSRLS`) with `app.tenant_id` set transaction-locally. A query that forgets `WHERE tenant_id` still sees only the current tenant's rows (tested in `packages/db/src/tenant-isolation.int.test.ts`).
- Composite foreign keys `(tenant_id, farm_id)` stop a child row pointing at another tenant's parent.
- All SQL is parameterised.

**Residual / operator:** cross-tenant system queries (`withSystem`) exist only for the alert sweep, pending-boundary sweep and public chain data; review any new use. Support staff access should be a time-boxed `memberships.expires_at` row, which is audited like any other.

## 2. Server-side request forgery (SSRF)

**Asset:** internal network (`*.railway.internal`, cloud metadata endpoints), credentials.
**Attacks:** submit a URL (imagery source, model URL, webhook callback, tileset URL) that the server then fetches.

**Controls**
- The API never fetches user-supplied URLs. Uploads go browser → object storage via presigned PUT; the API only issues the signature and later calls `HeadObject` on a key it generated.
- Storage keys are built from UUIDs and an enum purpose (`buildStorageKey`); user file names never reach the key.
- Outbound endpoints (OIDC JWKS, RPC, imagery provider, S3 endpoint) are fixed configuration, never request-derived. `ImageryProvider` and `ChainReader` are interfaces whose implementations must keep that rule (documented in code).
- Cesium 3D Tiles URLs are loaded by the *browser* only.

**Residual:** when you implement a real imagery provider, use an allow-listed host and disable redirects to other hosts. If you ever add "import from URL", fetch through an egress proxy that blocks private address ranges.

## 3. Malicious GeoJSON

**Asset:** API/worker CPU and memory, database integrity.
**Attacks:** gigantic coordinate arrays, deeply nested arrays, `NaN`/`Infinity`/strings as coordinates, self-intersections that crash GIS code, huge areas, prototype-pollution keys, unsupported CRS tricking reprojection.

**Controls** (`packages/domain/src/geometry.ts`, run before any database work)
- Body size limit (2 MB on the boundary route, 1 MB elsewhere); prototype-poisoning keys rejected by the JSON parser.
- Nesting depth limit and a **vertex count limit checked before any O(n²) work**; ring and polygon count limits.
- Strict structure: Polygon/MultiPolygon only (or a single-feature wrapper); every position must be 2–3 finite numbers in range.
- Closed rings, ≥4 positions, non-collinear, no self-intersections or spikes, holes inside shells and not touching, antimeridian spans rejected.
- Geodesic area bounds; tenants can only tighten limits.
- CRS must be absent or WGS 84 — we never guess a reprojection.
- Duplicate detection via an orientation- and start-independent canonical hash (unique index per tenant).
- PostGIS `ST_IsValidDetail` re-validates asynchronously in the worker; failure marks the version invalid.

## 4. Unsafe uploads

**Asset:** users' browsers (stored XSS), storage costs, downstream parsers.
**Attacks:** upload HTML/SVG/script disguised as images; oversize files; overwrite another tenant's object; hotlink private files.

**Controls**
- Declared content type must be in an allow-list *for the declared purpose* (e.g. only `application/geo+json` for boundary imports; no SVG/HTML anywhere).
- Size limit enforced when issuing the ticket and signed into the URL (`content-length`, `content-type` are signed headers); on completion the stored object's size and type are compared and mismatches are deleted and rejected.
- Keys are server-generated under `tenants/{tenantId}/…`; presigned URLs are short-lived (default 5 min) and single-object.
- Bucket stays private; reads use presigned GETs.

**Residual / TODO(provider-config):** add malware scanning and image re-encoding (strip metadata such as EXIF GPS) before `uploaded` media is used; serve user content from a separate origin if you ever render it inline.

## 5. Wallet signature replay

**Asset:** account ↔ wallet links.
**Attacks:** replay a captured signature; reuse a signature made for another site (phishing); use a different chain; reuse an old message.

**Controls** (`packages/domain/src/wallet-auth.ts`, `apps/api/src/routes/chain.ts`)
- EIP-4361-style message with **domain, URI, chain ID, nonce, issued-at and expiration**, all checked server-side against configuration.
- Nonce: 32-char, CSPRNG, bound to the authenticated user, one outstanding per user, short TTL, **consumed atomically** (`DELETE … WHERE nonce AND user AND not expired`); a second use fails.
- Validity window capped to the nonce TTL; small clock-skew tolerance only.
- The statement says the signature authorises no transaction. Linking a wallet grants no tenant permission.
- The address ↔ user mapping lives only in `wallet_links`; it is never written on-chain or into token metadata, and audit logs record only the chain id.

## 6. Admin compromise

**Asset:** tenant data, NFT minting, platform configuration.
**Attacks:** stolen admin session; malicious insider; compromised CI or Railway account.

**Controls**
- Roles are per tenant; there is no global "superadmin" path in the API. `audit:read` and `member:manage` are admin/owner only.
- `audit_events` is **append-only** at the database level (trigger blocks update/delete; app role has `SELECT, INSERT` only).
- Contracts: `DEFAULT_ADMIN_ROLE` cannot mint, move, burn or raise supply; there is no confiscation function. The worst an on-chain admin can do is grant roles — which is visible on-chain (`RoleGranted`) and indexed.
- Dev auth provider and memory storage refuse to start in staging/production.

**Operator:** enforce SSO + hardware-key MFA on GitHub, Railway and the IdP; require reviews on `main`; restrict who can edit production variables; put the contract admin role on a multisig.

## 7. Key compromise

| Key | Impact | Mitigation |
| --- | --- | --- |
| OIDC signing keys (IdP) | Forged sessions | Verified via JWKS with issuer/audience/algorithm allow-list; rotate at the IdP; JWKS cache cooldown is short |
| `DEV_AUTH_SECRET` | Forged dev tokens | Blocked outside development/test by config validation |
| Webhook secrets | Forged provider events | Several secrets accepted at once for rotation; tolerance window; event-id de-duplication |
| S3 credentials | Read/write uploads | Scope to one bucket; rotate; bucket private |
| Database / Redis credentials | Full data access | Private network only; rotate via Railway variables; RLS still constrains app-role queries |
| Minter key | Mint up to remaining cap | Hot key holds only `MINTER_ROLE`; pauser stops minting; supply is capped; revoke role from admin multisig |
| Contract admin | Grant roles | Multisig; monitor `RoleGranted`/`RoleRevoked` events |
| Sensor credentials | Fake readings | Stored only as hashes (`sensors.credential_hash`); readings labelled `sensor-reported`; implausible values flagged and ignored by alerts |

## 8. Webhook forgery

**Controls:** HMAC-SHA256 over `timestamp.rawBody` with constant-time comparison; raw body preserved (no re-serialisation); timestamp tolerance (default 300 s); per-provider event-id de-duplication (`webhook_receipts`); rejected attempts audited; route-specific rate limit. Tenant/farm must be resolved from a registered integration, never trusted from the payload (TODO marked in code).

## 9. Chain-indexer inconsistency

**Risks:** reorgs removing indexed events; RPC returning stale or inconsistent data; duplicate processing; UI presenting unconfirmed events as final.

**Controls** (`apps/worker/src/handlers/chain.ts`)
- Only blocks at least `CHAIN_CONFIRMATIONS` deep are indexed and marked confirmed.
- The cursor stores the last block **hash**; on mismatch the indexer rewinds a fixed window, marks events from that point `removed`, and re-indexes.
- Events are upserted on `(chain_id, tx_hash, log_index)`, so retries and overlaps are idempotent.
- Unknown events are ignored rather than guessed.
- The database is never treated as the source of truth for ownership; it is a cache of public data for display.

**Residual:** for high-value displays, cross-check with a second RPC provider; alert when the cursor lags the head by more than N blocks.

---

## Also covered

- **Transport and headers:** helmet on the API (CSP `default-src 'none'`), nonce-based CSP and frame-ancestors `none` on the web app, HSTS when deployed, `no-store` on API responses.
- **Duplicate writes:** every tenant-scoped write accepts an `Idempotency-Key` (`apps/api/src/plugins/idempotency.ts`, migration 0021). The key is reserved before the handler runs and the 2xx response is stored, so a resend is replayed rather than re-run. If the outcome cannot be recorded, the key stays reserved and resends are refused (`idempotency_request_in_progress`) instead of repeated. Records are tenant-isolated by RLS and pruned per user after 24 hours. Tests: `apps/api/src/idempotency.int.test.ts`.
- **Abuse:** per-IP rate limiting. `RATE_LIMIT_STORE=redis` shares the counters across API replicas (keys under `QUEUE_PREFIX:rate-limit:`); the default `memory` store counts per process, so with N replicas a client gets up to N times the budget. The Redis store fails open: while Redis is unreachable, including the moments before its connection is first ready after the API starts, requests are served without limits, and a warning is logged once per outage. Tests: `apps/api/src/rate-limit.int.test.ts`.
- **Metrics:** `GET /metrics` (API, and the worker's health port) is off unless `METRICS_TOKEN` is set, then needs that bearer token (constant-time compare). It exposes counts and timings per route template and queue, never ids, URLs or tenant data (`docs/observability.md`).
- **Logging:** pino redaction of authorization headers, cookies, secrets, signatures and emails; IP addresses are salted hashes in audit records.

## Harvest registry signer key

**Asset:** the worker's `CHAIN_SIGNER_PRIVATE_KEY` (holds `RECORDER_ROLE` on `HarvestRegistry` and gas money).

**Threats:** key theft lets an attacker register fingerprints for batch ids that do not exist yet, void registered batches, or drain the gas balance.

**Controls:** the key holds only `RECORDER_ROLE` (the admin role is a different key); existing fingerprints can never be overwritten; batch ids are random UUIDs the attacker cannot predict in advance for real batches; the public page reports any on-chain mismatch instead of hiding it; the key lives only in the worker's secret store and is never logged.

**Operator:** keep the minimum gas on the key; on suspected theft, revoke `RECORDER_ROLE` from the old address with the admin key, grant it to a new key, and update the worker setting.
