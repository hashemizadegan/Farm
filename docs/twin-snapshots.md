# Farm-state snapshots, content-addressed storage, anchors and unsigned intents

Status: domain modules with tests (`packages/domain/src/twin/`). Snapshots and the content store
(`packages/storage`, shared by the API and the worker) are wired into the API
(`apps/api/src/routes/twin-snapshots.ts`) and, behind a flag that is off by default, into a scheduled
worker job. Anchor plans are served read-only; intents are not wired. Nothing is written on-chain, and
nothing can be signed or submitted.

## Snapshot API and client sync

- `POST /v1/tenants/{t}/twin/farms/{farmId}/snapshots` (`rwa:operate`, `Idempotency-Key`): reads the
  farm's business assets, equipment (with the latest hour-meter reading), crop seasons and on-farm stock
  (`packages/db/src/repositories/twin-snapshot.ts`, values built as plain JSON in SQL), builds the
  snapshot, stores its canonical bytes at `tenants/{t}/content/{sha256}` and records a data commitment
  (`schema: metafarm.farm-snapshot`, reserved: the generic commitment endpoint refuses it). Audited.
- `GET …/farms/{farmId}/snapshots` (`rwa:read`): commitments, newest first.
- `GET …/snapshots/{commitmentId}` (`rwa:read`): the bytes re-hashed (409 `content_integrity_failed`
  if they changed, 404 `snapshot_content_missing` if gone) and the snapshot verified end to end;
  ETag = snapshotId.
- Unchanged state gives the same `root`; the `snapshotId` differs because it covers `takenAt`.
- The C# client's `SnapshotSync` fetches only when the newest commitment changed and keeps the new
  snapshot only if both the server's check and its own structure check pass.

## Snapshots (`snapshot.ts`, scheme `metafarm-farm-snapshot/1`)

A snapshot records a farm's entities at one moment so the state can be rebuilt and checked without
the database.

| Entity type | Platform record it is built from |
| --- | --- |
| `plot` | `business_assets` (kind `parcel`) and verified boundary geometry |
| `crop` | `crop_seasons` / `season_stages`; trees are `business_assets` (kind `tree`) |
| `structure` | `business_assets` (kinds `building`, `storage_unit`) |
| `inventory` | `input_items` and stock levels; output batches from `harvest_batches` |
| `machine` | `equipment` with meter readings |
| `animal` | `business_assets` (kind `livestock`) |
| `asset` | any other registry asset (`harvest_lot`, `logistics_lot`, `farm_share`) |

How the hashes are built:

1. Entity hash = `commitToRecord("metafarm.entity.<type>", 1, data)`. This is the SHA-256 of the canonical JSON of `{scheme, schema, schemaVersion, record}`.
2. Entities are ordered by (type, id). Their hashes are the leaves of an RFC 9162 Merkle tree (`metafarm-merkle-sha256/1`), giving `root`.
3. `snapshotId` = SHA-256 of the canonical header `{entityCount, entitySchemaVersion, farmId, root, scheme, takenAt}`; it names the state. The stored bytes (`serializeFarmSnapshot(s)`) are content-addressed by their own SHA-256, which the data commitment records.

Rules and functions:

- **Data must be plain JSON.** Non-finite numbers, `undefined`, dates and class instances are refused, never coerced, because a hash must survive a round trip through JSON.
- **Rebuilding:** `reconstructFarmSnapshot(json)` parses a stored snapshot and re-verifies every entity hash, the order, the root and the id.
- **Selective disclosure:** `snapshotEntityProof` gives an inclusion proof for one entity, so it can be disclosed without the rest.
- **C# client:** `SnapshotVerifier` checks the order, root and id against the same sample (`clients/unity-starter/Samples/farm-snapshot.sample.json`). It does not recompute entity hashes from their data, because that needs the platform's canonical JSON for arbitrary numbers.

## Content-addressed storage (`content-store.ts`)

- **The port:** `ContentStore` has `put`, `get` and `has`, keyed by the SHA-256 of the bytes.
- **Integrity:** every `get` re-hashes the bytes and throws `ContentIntegrityError` when they no longer match their address.
- **References:** `put` returns a `sha256:<hex>` reference that `checkStorageRef` accepts for data commitments.
- **Implementations:** `createMemoryContentStore` is for tests and local work. A production adapter over the existing S3-compatible `ObjectStorage` (keys `<prefix>/<sha256>`) is a later PR.

## Scheduled snapshots (worker, off by default)

Two settings, both unset or false by default, so deploying this changes nothing:

| Setting | Service | Effect |
| --- | --- | --- |
| `TWIN_SNAPSHOT_CRON` | scheduler | Registers the repeatable `twin-snapshots-sweep` job (queue `twin-snapshots`). When unset the scheduler removes it. |
| `TWIN_SNAPSHOTS_ENABLED` | worker | Lets the worker run the jobs and create object storage for them. When false, every job finishes as `skipped`. |

- The sweep lists every farm (system transaction, at most 5000) and enqueues one job per farm, with
  the idempotency key `twin-snapshot:<tenant>:<farm>:<hour bucket>`, so a farm gets at most one job per
  hour however often the sweep runs.
- The farm job builds the snapshot exactly as `POST …/snapshots` does, in the farm's tenant (RLS). It
  records nothing when the root equals the newest stored snapshot's root (`unchanged`), or when the
  farm is gone, has nothing to snapshot, or is too large (`skipped`). A newest snapshot whose bytes no
  longer verify counts as changed, so a fresh one is stored.
- A recorded snapshot has `recorded_by` null and an audit entry `twin.snapshot.recorded` with actor
  type `job`.
- Storage is the same S3-compatible store and the same content-addressed keys as the API.

## Anchor plans (read-only)

- `GET /v1/tenants/{t}/twin/data-commitments/batches/{batchId}/anchor-plan?carrier=&network=`
- `GET /v1/tenants/{t}/twin/snapshots/{commitmentId}/anchor-plan?carrier=&network=`

Both need `rwa:read`, store nothing and return `planAnchor`'s result (`executable: false`). The
snapshot endpoint re-reads and re-verifies the stored snapshot first (409 if it does not verify). The
label is the batch's dataset, or `farm-` and the first 14 hex digits of the farm id for snapshots, so
Token-2022 keys stay within 32 bytes; a longer key is refused (422 `anchor_plan_refused`), never
truncated. `network` defaults to `solana-devnet`; `solana-mainnet` is refused unless
`RWA_MAINNET_ENABLED`. The Bubblegum carrier needs `RWA_CNFT_METADATA_BASE_URL` (409 `not_configured`
otherwise) and an https base (422 otherwise).

## Reserved anchor formats (`anchor.ts`, scheme `metafarm-anchor/1`)

`planAnchor` describes exactly what would be written on Solana for a batch or snapshot root. Every plan has `executable: false` and `reason: anchoring_not_enabled`.

| Carrier | Where the root goes | Format and limits |
| --- | --- | --- |
| `token2022_metadata` | An additional metadata field on the farm's anchor mint (Token Metadata extension) | key `mf:<subject>:<label>` (at most 32 bytes); value `<scheme>:<root>` |
| `bubblegum_v1_leaf` | Immutable leaf metadata whose URI points at a public anchor document | name at most 32 bytes, symbol `MFANCHOR`, URI at most 200 bytes (`CNFT_METADATA_LIMITS`) |

Mainnet is refused unless `mainnetEnabled`, and so are non-Solana networks.

## Unsigned intents (`intents.ts`, scheme `metafarm-intent/1`)

`buildMintIntent`, `buildTransferIntent` and `buildTradeIntent` produce a complete description of an operation. Each intent carries:

- its legs and required signers;
- the ownership slots it was checked against;
- an expiry;
- a SHA-256 digest.

Each intent also has no signatures and `submission.available: false`. No key material is involved and no transaction bytes are built.

What each builder checks:

- **Transfer and trade:** refused unless the chain's holders are known and cover every leg.
- **Trade:** moves the asset seller → buyer and a Token-2022 payment buyer → seller, so it would need one transaction signed by both parties.
- **Compressed-NFT mint:** refused if the asset already exists on-chain.

## Next steps

1. Anchor execution (writing roots on-chain), only behind an explicit flag, a KMS signer and review.
2. Wallet-signed submission of intents, only after Solana wallet linking and the ownership indexer.
