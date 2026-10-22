# Provider capabilities

Every feature that depends on an external provider has one typed state, reported at start-up by
`packages/config/src/capabilities.ts`:
- **`enabled`:** a provider is selected and configured. `simulated` marks development stand-ins: memory
  storage, mock imagery and dev sign-in. Deployed environments refuse those.
- **`disabled`:** intentionally off. This is the default for every optional provider; the feature is unavailable
  and says so.
- **`missing`:** a provider is selected but required variables are absent.
- **`invalid`:** the settings contradict each other or the environment.

The API and the worker call `assertCapabilities` at start-up:
- `missing` or `invalid` **stops the process**. The message names the capability, its category and the variable
  names, never values.
- Otherwise one log line describes everything, for example
  `auth=enabled(oidc) storage=enabled(s3) chain-events=disabled media-scanning=disabled`.

| Capability | Category | Service | Selection | Required when selected | Default |
|---|---|---|---|---|---|
| `auth` | identity | api | `AUTH_PROVIDER=oidc` | `OIDC_ISSUER_URL`, `OIDC_AUDIENCE` | `dev` (needs `DEV_AUTH_SECRET`; invalid when deployed) |
| `storage` | storage | api, worker | `STORAGE_DRIVER=s3` | `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; `S3_ENDPOINT` must be https when deployed | `memory` (invalid when deployed) |
| `imagery` | imagery | worker | `IMAGERY_PROVIDER` | No real provider is integrated yet | `none` → disabled (no scenes are fabricated); `mock` is invalid when deployed |
| `evm-chain` | chain | worker | `CHAIN_RPC_URL` | Contract addresses (`HARVEST_REGISTRY_ADDRESS`, `NFT_*`) need the RPC | disabled |
| `solana-rpc` | chain | worker | `RWA_SOLANA_RPC_URL` | `RWA_SOLANA_DAS_URL` needs the RPC; `solana-mainnet` needs `RWA_MAINNET_ENABLED` | disabled |
| `chain-events` | chain | api | `CHAIN_EVENT_PROVIDERS` | Each name needs an adapter (checked when the routes register) | disabled |
| `mqtt-telemetry` | telemetry | worker | `MQTT_URL` (TLS enforced by the schema) | – | disabled |
| `media-scanning` | media | api | – | No scanner is integrated | always disabled: uploads are checked for declared size and type only |
| `map-tiles` | maps | web | `NEXT_PUBLIC_MAP_STYLE_URL` | https (http only for localhost in development), and `NEXT_PUBLIC_MAP_ATTRIBUTION` | disabled: the built-in offline style |

`webCapabilities` is exported for the web build. It is not yet asserted in `next.config.ts`, which deliberately
imports nothing from the workspace.

## Chain events (provider-neutral)

`POST /v1/webhooks/<provider>` with a provider named in `CHAIN_EVENT_PROVIDERS`:
1. The body is normalized by that provider's adapter into `metafarm-chain-event/1`
   (`packages/domain/src/chain-events.ts`).
2. The event's network is checked against `RWA_SOLANA_NETWORK`.
3. Only then are the receipt (idempotent per provider event id) and an audit row stored. The audit row holds the
   normalized summary and the SHA-256 of the body, not the body.
4. An at-least-confirmed ownership change for a **tracked** asset re-queues an ownership-index read of that asset
   from the verified chain source. The event never writes ownership itself.

The only adapter shipped is `metafarm-relay`, which takes the canonical form. A vendor adapter is added with
fixtures from that vendor's documented payloads, once a vendor is chosen.

## Decisions pending (owner: platform owner unless stated)

- **imagery:** choose a provider (licence, revisit, resolution), then implement `ImageryProvider` in
  `apps/worker/src/handlers/imagery.ts`.
- **map tiles / globe:** choose a style and tile source and its attribution. Cesium terrain or 3D Tiles stay
  optional (`packages/map-scene/src/map/cesium.ts`).
- **media scanning:** choose a malware scanner or re-encoding service (docs/threat-model.md). Until then the
  capability stays disabled, and nothing claims an upload was scanned.
- **chain-event vendor:** choose a webhook vendor and add its adapter and fixtures. Until then, a relay can post
  canonical events.
- **telemetry webhooks (sensor and observation feeds):** need a registered-integration table that resolves the
  workspace from the integration id, never from the payload. Until then those webhooks are receipted and audited
  only.
- **disclosure texts (owner: counsel):** legal review per jurisdiction, including the Persian translation
  (`apps/web/src/app/about/disclosures/page.tsx`).

## Before merging to `main`

Two `invalid` rules are new and would stop a live service on its next deploy if they match:
- an `http://` `S3_ENDPOINT` when deployed;
- `RWA_SOLANA_NETWORK=solana-mainnet` without `RWA_MAINNET_ENABLED`.

Check the live api and worker values for these two before any merge. This branch is not deployed.
