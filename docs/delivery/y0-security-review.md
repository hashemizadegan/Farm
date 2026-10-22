# Y0 security review (verified cluster identity, #85)

Reviewed 2026-10-22 against the code at `243191b`. One fix landed as a result: `20ccaae` on the same branch.
Plan revision 4 (`f914af4`): §4.2, §11.1 row Y0, §12 D-16, safeguards 13 and 18.

**Scope:**
- `packages/chain/src/solana/cluster.ts`: verification and endpoint sanitisation.
- `packages/db/migrations/0023_ownership_source_identities.{up,down}.sql`.
- `packages/db/src/repositories/ownership-index.ts`: registration, binding, cursor, reader.
- `apps/worker/src/handlers/ownership-index.ts` and `apps/worker/src/main.ts`: guard, per-batch verification,
  transaction boundary, start-up registration.
- The Y0 tests.

**Method:** code reading; real-PostgreSQL 16 runs of migrations 0020 and 0023 and of the repository's statements;
a reproduction of the one defect before and after the fix.

**Not a sign-off.** The plan proposes a security sign-off (S) for Y0 (§11.2). This review is input to it.

## Findings

| # | Severity | Location (at `20ccaae`) | Finding | Status |
| --- | --- | --- | --- | --- |
| F1 | **Medium** (latent) | `packages/db/src/repositories/ownership-index.ts`: `ownershipCursorOf` (l.151), `advanceOwnershipCursor` (l.131), `insertOwnershipEvents` (l.94) | **Pre-0023 RPC rows could make the reader serve partial history.** An unbound pre-0023 RPC cursor was still used by the indexer, which fetched only later events. The cursor was then bound with `GREATEST(old, new)`, and re-observed earlier events were skipped (`ON CONFLICT DO NOTHING`), so they stayed unbound. The reader then served a bound cursor over an incomplete history. Reproduced on PostgreSQL 16: cursor 700 served with only the transfer, the mint hidden. A stale cursor above the verified source would also block the asset (`source_behind_cursor`). **Latent:** J7 has not run with an RPC source in any environment (off by default, deploy hold), so no such rows exist today. | **Fixed in `20ccaae`.** The unbound cursor is ignored, so the asset is re-indexed from the start. Its slot is replaced, not kept. Identical re-observed rows are bound to the verified identity; nothing else is updated. Verified on PostgreSQL 16 and by a new integration test. |
| F2 | Medium (pre-existing; D-17 scope) | `readOwnershipIndex` (l.165); `combineOwnershipSources` (`packages/chain/src/twin/bubblegum-ownership-source.ts` l.163) | **Fixture and RPC rows can coexist for one asset, and the reader serves both.** A combined source with any RPC member reports `rpc`, so events from a fixture member would be stored as `rpc` and bound to the identity. The worker combines only RPC sources today. | **Open for D-17** (enforcement layers). Not changed by Y0. |
| F3 | Low | `apps/worker/src/main.ts` l.86 | When start-up registration failed for a reason other than the cluster check (e.g. a database error), the log said only `code: unknown`. | **Fixed in `20ccaae`.** Now logs the error's name and message. Cluster errors carry only scheme and host. |
| F4 | Info | `verifyClusterIdentity` (`cluster.ts` l.113) | The genesis hash is reported by the RPC provider itself. Verification detects misconfiguration (wrong cluster), not a provider that lies. Provenance is not completeness (§4.2). | Inherent; documented in the plan. Node choice [Ext]. |
| F5 | Info | migration 0023 l.18 | IPv6 literal hosts (`[::1]`) fail the host check, so registration fails closed. | Acceptable; not supported. |
| F6 | Info | migration 0023 l.41–49 | The identity checks are `NOT VALID`. `VALIDATE CONSTRAINT` will fail while unbound pre-0023 RPC rows remain. Those rows are unserved; rebuilding the index removes the need for them. | Operational note for a future clean-up. |
| F7 | Info | `ownershipIndexHandler` (handler l.118–122) | Two verifications per batch, each with up to 3 attempts. A slow endpoint can delay a job by tens of seconds. This affects availability only; failures write nothing. | Accepted. |
| F8 | Info | migration 0023 l.54 | The application role can read identity rows: network, genesis hash, scheme and host (the RPC provider's host name). No credentials. | Accepted (§7.2 proposes this table). |

## Checks that passed (no finding)

- **Identity registration:** one row per (network, genesis hash, scheme, host). Re-registration updates
  `last_verified_at` only, keeping the first verifier. Registration happens in the same transaction as the batch
  writes, so a refusal by the database aborts the whole batch.
- **Endpoint sanitisation:** `endpointIdentity` keeps the scheme (http or https only) and the lowercase host and
  port. URL user info, path, query and fragment are dropped. Error messages use `redactEndpoint`. The database
  host check refuses `/`, `?`, `#`, `@`, whitespace and uppercase. No log or error carries a credential (tested
  with a key in path and query).
- **Database permissions:** `metafarm_app` gets `SELECT` on identities only; insert and update are refused
  (42501, tested on PostgreSQL). The writes run as the system role.
- **Constraints:**
  - the genesis hash is pinned per network label;
  - the composite foreign key (id, network) forbids cross-network identities;
  - `rpc` rows require an identity and `fixture` rows refuse one;
  - unbinding a row is refused;
  - 28 constraint cases were run on PostgreSQL 16 with the expected SQLSTATEs.
- **Event and cursor binding:** both rows are written in one system transaction with the identity verified
  before and after the read. A changed identity, another network, or any cluster error happens before the
  transaction, so nothing is written and the cursor doesn't move (unit tests use a pool that throws if
  touched; integration tests check rows and cursor).
- **Reader and pre-0023 rows:** unbound RPC cursors and events are never served (cursor and event filters). With
  F1 fixed, they are also never trusted by the indexer.
- **Fail-closed defaults:** `TWIN_OWNERSHIP_INDEX_ENABLED` stays off by default, and no guard is built and no RPC
  is contacted unless it is enabled. An RPC source without a guard is refused (`identity_not_configured`).
  Mainnet still needs `RWA_MAINNET_ENABLED`, which is unchanged.

## Remaining before Y0 is used live (not part of this review)

- The deploy hold lifted and J7 enabled by the owner.
- The proposed security sign-off (S).
- A full-history node chosen and documented (§4.2).
- F2 decided under D-17.

## Follow-up (2026-10-22): F2

F2 was settled by the owner under D-17 ("verified RPC takes precedence") and fixed in #86: see
`decision-brief-d17-fixture-exclusion.md`, "Owner decision". This review is still not a security sign-off.
