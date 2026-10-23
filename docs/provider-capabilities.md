# Provider capabilities

Every feature that depends on an external provider has one typed state, reported at start-up by
`packages/config/src/capabilities.ts`:
- **`enabled`:** a provider is selected and configured. `simulated` marks development stand-ins: memory
  storage, mock imagery and dev sign-in. Deployed environments refuse those.
- **`disabled`:** intentionally off. This is the default for every optional provider; the feature is unavailable
  and says so.
- **`missing`:** a provider is selected but required variables are absent.
- **`invalid`:** the settings contradict each other or the environment.

The API and the worker call `assertCapabilities` at start-up, and the web build calls it in `next.config.ts`:
- `missing` or `invalid` **stops the process**. The message names the capability, its category and the variable
  names, never values.
- Otherwise one log line describes everything, for example
  `auth=enabled(oidc) storage=enabled(s3) chain-events=disabled media-scanning=disabled realtime=disabled integrations=disabled`.

| Capability | Category | Service | Selection | Required when selected | Default |
|---|---|---|---|---|---|
| `auth` | identity | api | `AUTH_PROVIDER=oidc` | `OIDC_ISSUER_URL`, `OIDC_AUDIENCE` | `dev` (needs `DEV_AUTH_SECRET`; invalid when deployed) |
| `storage` | storage | api, worker | `STORAGE_DRIVER=s3` | `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; `S3_ENDPOINT` must be https when deployed | `memory` (invalid when deployed) |
| `imagery` | imagery | worker | `IMAGERY_PROVIDER` | No real provider is integrated yet | `none` → disabled (no scenes are fabricated); `mock` is invalid when deployed |
| `evm-chain` | chain | worker | `CHAIN_RPC_URL` | Contract addresses (`HARVEST_REGISTRY_ADDRESS`, `NFT_*`) need the RPC | disabled |
| `solana-rpc` | chain | worker | `RWA_SOLANA_RPC_URL` | `RWA_SOLANA_DAS_URL` needs the RPC; `solana-mainnet` needs `RWA_MAINNET_ENABLED` | disabled |
| `chain-events` | chain | api | `CHAIN_EVENT_PROVIDERS` | Each name needs an adapter with a valid declaration (checked when the routes register); the CI adapter `metafarm-fixture` is invalid when deployed | disabled |
| `realtime` | realtime | api | `REALTIME_EVENTS_ENABLED=true` | – (invalid in staging/production until the channel's security review) | disabled: clients poll; `GET /v1/realtime` does not exist |
| `integrations` | integrations | api | `INTEGRATION_SECRET_KEY` (≥ 32 characters) | – | disabled: integration routes answer 404 |
| `mqtt-telemetry` | telemetry | worker | `MQTT_URL` (TLS enforced by the schema) | – | disabled |
| `media-scanning` | media | api | – | No scanner is integrated | always disabled: uploads are checked for declared size and type only |
| `map-tiles` | maps | web (build) | `NEXT_PUBLIC_MAP_STYLE_URL` | https (http only for localhost in development); `NEXT_PUBLIC_MAP_ATTRIBUTION` (the text, or `from-style` when the style carries it); the style's origin in `NEXT_PUBLIC_MAP_CONNECT_SRC` | disabled: the built-in offline style |
| `globe-imagery` | imagery | web (build) | `NEXT_PUBLIC_CESIUM_ENABLED` | No licensed imagery or terrain source is chosen: `true` is invalid | disabled: 2D map only |
| `media-uploads` | media | web (build) | `NEXT_PUBLIC_UPLOAD_CONNECT_SRC` | Origins only; https when deployed (http on localhost in development) | disabled: no browser upload origin in the CSP |

The web build (`apps/web/next.config.ts`) asserts `webCapabilities` with the same rules: an enabled provider with an
incomplete or unsafe configuration fails the build, naming variables, never values. The map-tiles state is passed to
the bundle (`NEXT_PUBLIC_MAP_TILES_STATE`), and the map uses a tile provider only when that state is `enabled`
(`apps/web/src/lib/providers.ts`). No commercial provider is preset and no imagery is bundled.

## Chain events (provider-neutral)

`POST /v1/webhooks/<provider>` with a provider named in `CHAIN_EVENT_PROVIDERS`:
1. The body is normalized by that provider's adapter into `metafarm-chain-event/1`
   (`packages/domain/src/chain-events.ts`).
2. The event's network is checked against `RWA_SOLANA_NETWORK`.
3. Only then are the receipt (idempotent per provider event id) and an audit row stored. The audit row holds the
   normalized summary and the SHA-256 of the body, not the body.
4. An at-least-confirmed ownership change for a **tracked** asset re-queues an ownership-index read of that asset
   from the verified chain source. The event never writes ownership itself.

Each adapter declares (`ChainEventAdapterCapabilities`) the kinds, networks and rails it can produce, the finality
levels its provider reports and the minimum at which an ownership change becomes a re-read hint, and how requests are
verified (`platform-hmac`: the platform's webhook signature, checked by the route; `adapter`: the provider's own
scheme, in the adapter's `verify`). Declarations are checked at start-up; events outside them are refused. An ownership
change below the threshold is recorded as `awaiting_finality`; a later delivery at the threshold queues the re-read.

Adapters shipped:
- `metafarm-relay`: the canonical form (`{ id, type: "chain.<kind>", data }`), devnet and mainnet, hint threshold
  `confirmed`.
- `metafarm-fixture`: a deterministic CI adapter with its own documented wire shape (not any vendor's), devnet only,
  threshold `finalized`, refused when deployed. Fixtures for ownership, metadata, duplicate, malformed, wrong-network
  and delayed-finality deliveries: `packages/domain/fixtures/chain-events/`.

A vendor adapter is one new adapter (declaration, `normalize`, and `verify` for its own signature scheme) plus a
fixture folder with the same cases, from that vendor's documented payloads, once a vendor is chosen.

## Registered integrations (sensor and observation feeds)

`POST /v1/integrations/{integrationId}/events`, signed `x-webhook-signature: t=<unix>,v1=<hex>` with the
integration's own secret (migration 0031; `apps/api/src/routes/integrations.ts`):
- the workspace is the integration's; a payload naming a workspace is refused (`integration_event_workspace_in_payload`),
  and sensors and farms are looked up in the integration's workspace only;
- events (`metafarm-integration-event/1`: `sensor.readings`, `observation.reported`) become `provider-observation`
  raw observations in the existing pipeline; idempotent per integration and provider event id;
- secrets are derived from `INTEGRATION_SECRET_KEY`, shown once at registration and rotation, never stored (only
  their SHA-256); rotation stops the previous secret at once; revocation is final;
- every outcome is audited: `integration.event_accepted`, `…_replayed`, `…_rejected` (with the reason), `…_revoked`.

## Realtime channel

`GET /v1/realtime` (WebSocket, protocol `metafarm-realtime.1`, `packages/domain/src/realtime.ts`), only when
`REALTIME_EVENTS_ENABLED=true` (local and isolated preview; refused in staging and production). Authentication during
the handshake (bearer header, or the `bearer.<token>` subprotocol next to `metafarm-realtime.1`); one subscription per
connection (workspace, optional farm, event types, replay cursor); events from the durable outbox (migration 0030) in
cursor order; heartbeat timeout 4408, backpressure 1013, refusals 4400/4403/4404/4409. Polling stays the default for
every client; the Unity starter's `WebSocketRealtimeChannel` is used only when enabled.

## Decisions pending (owner: platform owner unless stated)

- **imagery:** choose a provider (licence, revisit, resolution), then implement `ImageryProvider` in
  `apps/worker/src/handlers/imagery.ts`.
- **map tiles / globe:** choose a style and tile source and its attribution. Cesium terrain or 3D Tiles stay
  optional (`packages/map-scene/src/map/cesium.ts`).
- **media scanning:** choose a malware scanner or re-encoding service (docs/threat-model.md). Until then the
  capability stays disabled, and nothing claims an upload was scanned.
- **chain-event vendor:** choose a webhook vendor and add its adapter and fixtures. Until then, a relay can post
  canonical events.
- **realtime in deployed environments:** the channel needs its security review before `REALTIME_EVENTS_ENABLED` is
  allowed in staging or production (today: refused by configuration).
- **integration partners:** which sensor or observation providers to register, and who in each workspace manages them
  (`integration:manage`: admins and owners).
- **disclosure texts (owner: counsel):** legal review per jurisdiction, including the Persian translation
  (`apps/web/src/app/about/disclosures/page.tsx`).

## Before merging to `main`

Two `invalid` rules are new and would stop a live service on its next deploy if they match:
- an `http://` `S3_ENDPOINT` when deployed (api and worker);
- `RWA_SOLANA_NETWORK=solana-mainnet` without `RWA_MAINNET_ENABLED` (worker).

Check the live api and worker values for these two before any merge. Both rules stay strict: an isolated preview
(`APP_ENV` development/test behind `PREVIEW_ACCESS_GATE`) may use an http endpoint inside its project, and devnet is
always accepted (tests: `packages/config/src/provider-config.test.ts`).

The web build now applies the web rules too. Before a merge, also check the live **web** build variables:
`NEXT_PUBLIC_MAP_STYLE_URL` set requires `NEXT_PUBLIC_MAP_ATTRIBUTION` (`from-style` for a style that carries its own
attribution, as the staging setup's OpenFreeMap style does) and the style's origin in `NEXT_PUBLIC_MAP_CONNECT_SRC`;
`NEXT_PUBLIC_CESIUM_ENABLED` must not be `true`; `NEXT_PUBLIC_UPLOAD_CONNECT_SRC` must list https origins. Nothing here
changes a live value; this branch is not deployed.
