# Ownership index (J7)

Status: implemented on a draft branch, with automated tests. **Off by default and not deployed.**
No chain-reading event source exists yet (next slice), so a deployed worker indexes nothing even when
enabled.

## Why

Ownership must come from the chain, never from platform records. `GET /twin/assets/{id}` reports
ownership only through an `OwnershipReader`. Without one, it says `not_indexed`, and transfer previews
are refused (`ownership_not_indexed`). The index gives the API a reader that is backed by finalized
chain events rather than by live provider calls, and that says exactly which slot its answer is as of.

## How it works

| Piece | Where | What it does |
| --- | --- | --- |
| Events | `chain_ownership_events` (migration 0020) | Finalized mint, transfer and burn events of Solana assets (Token-2022 mints, Bubblegum asset ids). Public data, not tenant-scoped. Append-only: the same event read twice is one row; a *different* event under the same (signature, instruction) is kept, so it surfaces as a conflict. |
| Cursor | `chain_ownership_cursors` | Per asset, the slot through which every finalized event is stored. It only moves forward. |
| Holdings | not stored | Rebuilt on read with `rebuildOwnership` (packages/domain). A database row can never say more than the events do. |
| Reader | `IndexOwnershipReader` (packages/chain) | `source: chain_index`, `assurance: indexer_reported`. The reading is as of the asset's cursor slot, and events after the cursor are ignored. An asset without a cursor is not covered (`not_indexed`), and an indexed asset with no events holds nothing. Contradictory events make it throw, which the API shows as `not_indexed` / `reader_unavailable` (fail closed). |
| Read path | `readOwnershipIndex` (packages/db) | A read-only transaction as the application role, which may only `SELECT` these tables. |
| Ingestion | `ownership-index` queue (apps/worker) | The sweep enqueues one job per Solana asset that has a chain identity. The job asks an `OwnershipEventSource` for events after the cursor and refuses events of another asset or outside (cursor, throughSlot]. In one system transaction it stores the events and advances the cursor. A source that is behind the cursor changes nothing. |
| Event source | `OwnershipEventSource` port (packages/domain) | `createFixtureEventSource` for tests and local use. **A chain reader (RPC, finalized commitment) is not built yet.** |

## Settings (all off by default)

| Setting | Service | Effect |
| --- | --- | --- |
| `TWIN_OWNERSHIP_INDEX_ENABLED` | api | Use `IndexOwnershipReader` for ownership. When off, ownership reads `not_indexed` (`no_ownership_reader`). |
| `TWIN_OWNERSHIP_INDEX_ENABLED` | worker | Run `ownership-index` jobs. Also needs an event source; none is configured in deployed workers yet, so jobs are skipped. |
| `TWIN_OWNERSHIP_INDEX_CRON` | scheduler | Registers `ownership-index-sweep`. When unset, any earlier schedule is removed. |

Nothing here signs, submits or holds keys, and no RPC endpoint or credential is needed to build or
test it.

## Next

1. A chain-reading `OwnershipEventSource`: finalized Token-2022 transfers and Bubblegum events, parsed
   from recorded RPC responses in tests, read-only.
2. Then decide (owner) whether to enable the reader and job on staging. That needs a deploy, which is
   currently on hold.
