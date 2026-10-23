# Chain event fixtures (`metafarm-fixture/1`)

Deterministic deliveries for the CI adapter `metafarm-fixture` (packages/domain/src/chain-events.ts). The wire shape is
the fixture adapter's own, deliberately not any vendor's: it exists to exercise the adapter boundary (declaration,
mapping, refusal, idempotency, finality) without inventing a vendor mapping. Addresses are made up (valid base58 only).

| File | What it proves |
|---|---|
| `ownership.json` | a finalized transfer maps to an `ownership_change` and asks for a re-read of a tracked asset |
| `metadata.json` | a metadata update maps, and is never an ownership hint |
| `duplicate.json` | the same `deliveryId` again (different timestamp): answered `duplicate`, nothing stored or queued |
| `malformed.json` | a non-decimal amount: refused (`chain_event_malformed`) before anything is stored |
| `wrong-network.json` | mainnet on an adapter that declares devnet only: refused (`chain_event_unsupported_network`) |
| `delayed-finality-*.json` | the same transaction at `processed`, `confirmed`, then `finalized`: only `finalized` (this adapter's threshold) queues the re-read |

A vendor adapter added later brings its own fixture folder with the same cases.
