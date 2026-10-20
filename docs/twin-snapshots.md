# Farm-state snapshots, content-addressed storage, anchors and unsigned intents

Status: domain modules with tests (`packages/domain/src/twin/`). Nothing here is wired into the API
or the worker yet, nothing is written on-chain, and nothing can be signed or submitted.

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
3. `snapshotId` = SHA-256 of the canonical header `{entityCount, entitySchemaVersion, farmId, root, scheme, takenAt}`. Storing `serializeFarmSnapshot(s)` under that id makes the snapshot content-addressed.

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

1. API endpoints that build snapshots from the database and store them through a `ContentStore`.
2. An S3 adapter for `ContentStore`.
3. Anchor execution (writing roots on-chain), only behind an explicit flag, a KMS signer and review.
4. Wallet-signed submission of intents, only after Solana wallet linking and the ownership indexer.
