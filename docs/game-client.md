# Game client boundary

The 3D farm metaverse is a **separate client** (Unity 6 with URP is the recommended first engine; see
"Engine" below). It is not a page of `apps/web`. The web app remains the place for administration,
operations, approvals, reporting and monitoring. This document is the contract between the client
and the platform.

A read-only starter lives in [`clients/unity-starter`](../clients/unity-starter). Its
engine-independent core (models, GET-only transport, read client, ownership display, Merkle
verification, mocks) builds and is tested in CI as netstandard2.1. Its Unity layer (HTTP transport,
local frame, scene loader) must be compiled in Unity 6. It is a starting point for the first
milestone, not a production client or a complete metaverse.

## Trust model

| Data | Source of truth | What the client may assume |
| --- | --- | --- |
| Who owns or holds an asset | The chain (Solana), read through an `OwnershipReader` | Only what `ownership` says, with its `source`, `assurance` and `asOfSlot`. `not_indexed` means unknown. |
| Transfers, sales | On-chain transactions signed by the user's wallet | Nothing until a transaction is final; previews are not transactions |
| Asset identity, geometry, status | The platform registry (`business_assets`), verified by a second person | As returned; `status` and `verifiedAt` say how far it is verified |
| Off-chain data (surveys, telemetry windows, media, scene bundles) | Object storage, identified by SHA-256 | `state: included` only means the Merkle proof was re-checked against the stored batch root; `anchored` (root on-chain) is not produced yet |
| Scene layout, camera, presence | Nobody: client state | Disposable |

The client sends **requests**, never state. It never holds platform secrets or private keys. Every
decision (permissions, ownership, transfer checks) is made by the API.

## Identity

1. The user signs in with the platform's OIDC provider (authorization code with PKCE in the system
   browser, a native-app client registered for the game). The access token is sent as
   `Authorization: Bearer …`.
2. Roles come from the workspace membership. The scene needs `farm:read`; assets, ownership and
   data need `rwa:read`; recording data, building batches and transfer previews need `rwa:operate`.
3. Wallet linking (Sign-In With Solana) is a later PR; until then the client shows chain holders as
   addresses and does not claim that an address belongs to the signed-in user.

## API (`/v1/tenants/{tenantId}/twin`)

All endpoints are in `packages/contracts/openapi.yaml` under the `twin` tag.

| Method and path | Permission | Purpose |
| --- | --- | --- |
| `GET /farms/{farmId}/scene?limit&cursor` | `farm:read` | Farm origin and outline, and assets as scene objects (layer, kind, geometry, physical and chain identity). Without `rwa:read`, asset layers are withheld and listed in `redacted`. |
| `GET /assets/{assetId}` | `rwa:read` | One object with lifecycle, ownership per representation, and its latest data commitments |
| `GET /data-commitments?subjectType&subjectId&limit&cursor` | `rwa:read` | Commitments, newest first |
| `POST /data-commitments` | `rwa:operate` | Record a content hash (content-addressed `storageRef` only); `Idempotency-Key` supported |
| `POST /data-commitments/batches` | `rwa:operate` | Fix an RFC 9162 Merkle batch of commitments |
| `GET /data-commitments/{id}/proof` | `rwa:read` | Inclusion proof, re-checked on every call |
| `POST /transfers/preview` | `rwa:operate` | A fingerprinted, expiring description of a transfer; refused unless chain holders are known and include the sender; `submission.available` is always false in this release |
| `GET /transactions/{operationId}` | `rwa:read` | State of one chain operation |
| `GET /farms/{farmId}/snapshots?limit&cursor` | `rwa:read` | A farm's state snapshots (data commitments), newest first: the sync check |
| `POST /farms/{farmId}/snapshots` | `rwa:operate` | Record a snapshot of the farm's current state (stored content-addressed; nothing on-chain) |
| `GET /snapshots/{commitmentId}` | `rwa:read` | The stored snapshot, re-verified on read; ETag = snapshotId |
| `GET /snapshots/{commitmentId}/content` | `rwa:read` | The snapshot's exact stored bytes (canonical JSON); SHA-256 of the body = the commitment's `contentSha256` (also the ETag) |
| `GET /snapshots/{commitmentId}/anchor-plan?carrier&network` | `rwa:read` | What would anchor the snapshot's root on Solana; data only, `executable: false` |
| `GET /data-commitments/batches/{batchId}/anchor-plan?carrier&network` | `rwa:read` | The same for a batch root |
| `GET /sync-status` | `rwa:read` | Whether ownership is indexed and submission available; commitment and batch counts |

Conventions (as in the rest of the API): errors are `{ error, message, requestId, details? }`;
`404` also hides resources of other workspaces; lists page with `cursor` (pass `nextCursor`);
amounts and slots are decimal strings (u64); writes accept an `Idempotency-Key` (UUID) and a resend
returns the original result. Rate limits apply per IP.

## Scene coordinates

Geometry is GeoJSON in WGS 84. The client converts to metres around the farm origin (`farm.origin`,
else the first outline point) with the equirectangular approximation used by `packages/map-scene`:
east = Δlon × 111 320 × cos(origin lat), north = Δlat × 111 320. In Unity, +x is east and +z is
north. This is for visualisation, not surveying.

## Verifying off-chain data in the client

A client that downloads a data item can check it without trusting the API:

1. SHA-256 of the bytes equals `contentSha256`, and a `storageRef` of the form `s3://…/<hash>` or
   `sha256:<hash>` names the same hash.
2. With the proof from `GET /data-commitments/{id}/proof`: leaf = SHA-256(0x00 ‖ contentHash bytes),
   then the RFC 9162 §2.1.3.2 audit-path walk with SHA-256(0x01 ‖ left ‖ right) must give `root`.
3. Once roots are anchored on-chain (later), the root must also match the anchor transaction.

For a farm snapshot the C# starter's `SnapshotChain` does all of this and reports each link:
content (the bytes from `…/snapshots/{id}/content` hash to the commitment), structure (those same
bytes parse to a snapshot whose order, root and id check out), inclusion (the proof reaches the
batch root from that hash's leaf) and, optionally, the batch's anchor plan (plan-only, same root).
It never reports a root as anchored.

## What the client must never do

- Show a database value, a cache or a preview as ownership.
- Build, sign or submit a transaction without the user's wallet, or send a private key anywhere.
- Treat `fixture` sources as chain data (they exist for tests and local development).
- Hard-code an API key, access token or credentialed URL in a build.

## Engine

Unity 6 (URP) first: one C# codebase for Windows, macOS, Android, iOS and WebGL; a Solana SDK with
mobile wallet adapters (it does not cover Token-2022 or compressed NFTs, which is why the API prepares
transactions and the wallet only signs); Addressables for content-hashed asset delivery; Cesium for
Unity for 3D Tiles where supported. Unreal Engine 5 is the alternative if photoreal desktop visuals
outweigh mobile and web reach.

## Versioning

The scene document carries `scheme: metafarm-twin-scene/1`; a breaking change gets a new scheme. API
paths stay under `/v1`. The client should refuse a scheme it does not know rather than guess.
