# Ownership index (J7)

Status: implemented on draft branches, with automated tests. **Off by default and not deployed.**
Token-2022 assets and Bubblegum V1 compressed NFTs can be indexed from finalized transactions.

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
| Event source | `OwnershipEventSource` port (packages/domain) | `covers(asset)` and `eventsAfter(asset, afterSlot)`. Two adapters: `createFixtureEventSource` (tests, local use), and `createToken2022OwnershipSource` (see below). |
| Bubblegum source | `createBubblegumOwnershipSource` (packages/chain) | Reads the finalized history of the asset's Merkle tree, which comes from the platform's records (`asset_representations.tree_id`; null when unknown or ambiguous). A mint comes from the leaf-schema event that follows `mint_v1` / `mint_to_collection_v1`. A transfer (leaf owner to new leaf owner) and a burn are decoded from the instruction, with the asset derived as `leafAssetId(tree, nonce)`. A redeem of the asset is refused. On a first window, the asset's mint must be in the tree's history, otherwise nothing is stored and the asset stays not indexed (a wrong tree can never make it look unowned). Discriminators and layouts are tested against mpl-bubblegum. V1 instructions only. |
| Token-2022 source | `createToken2022OwnershipSource` + `httpSolanaHistoryRpc` (packages/chain) | Reads the mint's finalized signatures (newest first, paged, stopping at the cursor) and each successful transaction. It reduces each transaction to its change in holders: pre/post token balances netted per owner, losers paired with gainers in owner order as transfers, a leftover gain as a mint and a leftover loss as a burn. Failed transactions are skipped. It refuses (stores nothing) when a listed transaction is unavailable, a balance has no owner, or a window exceeds its limit. The RPC client has only `getSlot`, `getSignaturesForAddress` and `getTransaction`, all at `finalized`; it cannot send. |

## Settings (all off by default)

| Setting | Service | Effect |
| --- | --- | --- |
| `TWIN_OWNERSHIP_INDEX_ENABLED` | api | Use `IndexOwnershipReader` for ownership. When off, ownership reads `not_indexed` (`no_ownership_reader`). |
| `TWIN_OWNERSHIP_INDEX_ENABLED` | worker | Run `ownership-index` jobs with the Token-2022 and Bubblegum sources. It also needs `RWA_SOLANA_RPC_URL`, and reads `RWA_SOLANA_NETWORK` (mainnet only with `RWA_MAINNET_ENABLED`). Without them, jobs are skipped. Assets the source does not cover (other rail or network) are skipped. |
| `TWIN_OWNERSHIP_INDEX_CRON` | scheduler | Registers `ownership-index-sweep`. When unset, any earlier schedule is removed. |

Nothing here signs, submits or holds keys. No RPC endpoint or credential is needed to build or test
it: the tests use RPC responses constructed in the documented JSON-RPC shapes, not recordings from a
live cluster.

Known limits:
- Same-slot transactions are ordered as `getSignaturesForAddress` lists them, because `getTransaction`
  does not report a transaction's position in its block. An impossible order surfaces as a conflict,
  and the reader fails closed.
- The pairing of senders and receivers inside one transaction is a deterministic convention; holdings
  are exact.

## Next

1. Validate both sources against a real devnet mint and tree. That needs an RPC endpoint configured in
   an environment, and the owner's decision.
2. Then decide (owner) whether to enable the reader and job on staging. That needs a deploy, which is
   currently on hold.
