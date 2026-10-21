# PR readiness and deployment roadmap (PRs #40–#59)

Prepared 2026-10-21 for when review and merging begin. Nothing here has been merged or deployed. Every
PR is an open draft, staging runs `main` (`b59eaff`), and the holds in `plan.md` still apply.

Every fact below was checked against the branches on 2026-10-21:
- the merge order, with `git merge-base --is-ancestor`;
- migrations and destructive SQL, by scanning each new `*.up.sql`;
- API changes, by diffing `openapi.yaml` structurally between `main` and #59;
- the invariants, by searching the non-test diff and reading the cited tests.

## 1. Status

| PR | Scope | Tested tip | CI run | Result | Impl | Auto | Env | Dep |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #40 | Digital twin foundation, read-only game API, Unity starter | `149d015` | 39493507369 | 14/14, C# 19 | yes | yes | Unity pending | no |
| #41 | Farm-state snapshots, content-addressed store, reserved anchors, unsigned intents | `03542e0` | 39493765635 | 14/14 | yes | yes | no | no |
| #42 | Snapshots in the API, object-storage store, C# sync | `a7fa07e` | 39496924758 | 14/14, C# 26 | yes | yes | no | no |
| #43 | Scheduled snapshots (off), data-only anchor plans | `72590ab` | 39499473536 | 14/14, C# 26 | yes | yes | no | no |
| #44 | Scheduled snapshot batches (off), C# anchor-plan DTOs | `30947ee` | 39536081258 | 14/14, C# 30 | yes | yes | no | no |
| #46 | Exact-bytes snapshot content, C# `SnapshotChain` | `4128911` | 39538586800 | 14/14, C# 38 | yes | yes | no | no |
| #47 | Verified incremental sync, scene update plan | `b9fbf61` | 39540866024 | 14/14, C# 58 | yes | yes | Unity pending | no |
| #48 | Unity 6 validation package | `0d1ddcc` | 39543120912 | 14/14, C# 61 | yes | yes | Unity pending | no |
| #49 | Delivery plan and handoff (docs) | `d39d3fd` | 39543829354 | 14/14, C# 61 | n/a | yes | n/a | no |
| #50 | J7 ownership index (off) | `3796361` | 39545019453 | 14/14, C# 61 | yes | yes | live chain pending | no |
| #51 | J7 Token-2022 source | `23e6c65` | 39545027199 | 14/14, C# 61 | yes | yes | live chain pending | no |
| #52 | J7 Bubblegum source, acceptance fixes | `de27621` | 39568045306 | 14/14, C# 63 | yes | yes | live chain pending | no |
| #53 | Redis rate limits (opt-in) | `0c4b096` | 39569203736 | 14/14, C# 63 | yes | yes | no | no |
| #54 | `Idempotency-Key` on tenant writes | `a279c47` | 39569206824 | 14/14, C# 63 | yes | yes | no | no |
| #55 | Keyset pages for RWA lists; `/rwa` reads every page | `5ce8aa7` | 39569208447 | 14/14, C# 63 | yes | yes | no | no |
| #56 | Metrics and alert rules (off); collector examples | `2562ccf` | 39573969953 | 14/14, C# 63 | yes | yes | no collector (by decision) | no |
| #57 | J8 player wallets (off); Unity `heldByYou` | `ec62d53` | 39575392455 | 14/14, C# 65, e2e 46 | yes | yes | real wallet and Unity pending | no |
| #58 | Offline Token-2022 retry decision (not wired) | `132a40a` | 39576512792 | 14/14, C# 65, e2e 46 | yes | yes | n/a (offline by decision) | no |
| #59 | Retire the EVM wallet link | `fc77570` | 39576690363 | 14/14, C# 65, e2e 46 | yes | yes | no | no |

#45 is an issue (the worker build investigation), not a PR. Impl means implemented, Auto means automated
checks pass in CI on the tested tip, Env means validated in the target environment, and Dep means
deployed. CI success never counts as Env. C# counts come from the "Unity starter core (C#)" job
annotation. "e2e 46" is the Playwright count, and the J8 spec added two runs to the earlier 44.

## 2. Linear merge order

The stack is strictly linear: each PR's base is the PR before it, and each base is an ancestor of the
next head. #40 already contains the current `main` (`b59eaff`), so no rebase is needed today. If `main`
moves, update #40 first and merge it forward through the stack.

```
main ← #40 ← #41 ← #42 ← #43 ← #44 ← #46 ← #47 ← #48 ← #49 ← #50 ← #51 ← #52
     ← #53 ← #54 ← #55 ← #56 ← #57 ← #58 ← #59
```

| Step | PR | Branch | Base when merged |
| --- | --- | --- | --- |
| 1 | #40 | `feature/farm-metaverse-foundation` | `main` |
| 2 | #41 | `feature/farm-state-snapshots` | `main` (after #40) |
| 3 | #42 | `feature/twin-state-sync` | `main` |
| 4 | #43 | `feature/twin-snapshot-schedule` | `main` |
| 5 | #44 | `feature/twin-snapshot-batches` | `main` |
| 6 | #46 | `feature/twin-snapshot-chain` | `main` |
| 7 | #47 | `feature/twin-verified-sync` | `main` |
| 8 | #48 | `feature/unity-validation-kit` | `main` |
| 9 | #49 | `delivery/plan` | `main` |
| 10 | #50 | `feature/ownership-index` | `main` |
| 11 | #51 | `feature/ownership-source-token2022` | `main` |
| 12 | #52 | `feature/ownership-source-bubblegum` | `main` |
| 13 | #53 | `feature/api-rate-limit-redis` | `main` |
| 14 | #54 | `feature/api-idempotency` | `main` |
| 15 | #55 | `feature/rwa-pagination` | `main` |
| 16 | #56 | `feature/metrics` | `main` |
| 17 | #57 | `feature/player-wallets` | `main` |
| 18 | #58 | `feature/token2022-reconciliation` | `main` |
| 19 | #59 | `feature/retire-evm-wallet-link` | `main` |

How to merge without conflicts:
- **Use "Create a merge commit"** (or rebase-merge), in this order. Do not squash: squashing rewrites the
  commits that the next PR is built on, so the next PR would show the whole stack again and conflict.
- After each merge, retarget the next PR to `main`. GitHub does this automatically if the merged branch
  is deleted and the setting to delete head branches is on. Then wait for its CI before merging it.
- Fixes were merged forward, not back. Two were made later in the stack:
  - **J7:** the Token-2022 first-window check and the Unity `heldByYou`/slot label live in #52, not
    #50 or #51. Do not enable `TWIN_OWNERSHIP_INDEX_ENABLED` anywhere until #52 is merged.
  - **#53:** the Redis rate-limit test fix is in #53 itself.
- **Alternative:** review every PR, then merge #59 alone into `main` (it contains the whole stack).
  This is one merge, but it gives up per-PR history.
- Each PR must be marked ready for review first. That, and every merge, is the owner's action.

## 3. Blast radius and breaking changes

### API contract (`openapi.yaml`, `main` against #59)

| Change | PRs | Compatibility |
| --- | --- | --- |
| `POST /v1/wallet/nonce` and `POST /v1/wallet/verify` **removed** | #59 | **Breaking.** The only removed operations. The web app never called them; any other client gets 404. |
| `GET …/rwa/parties`, `…/assets`, `…/registrations`, `…/orders`: `limit`/`cursor` added; response gains `nextCursor` | #55 | **Behaviour change**, though the response shape is additive. A client that ignores `nextCursor` now gets at most 100 items, where the old cut-off was 200 (orders, registrations) or none (parties, assets). Unknown query parameters are now refused with 400. The only in-repo caller, the web `/rwa` page, is updated. |
| `POST …/rwa/assets`: `kind` accepts `building`, `storage_unit`, `logistics_lot` | #40 | Additive (a wider enum). |
| 20 new operations: twin read and verify routes, snapshots, anchor plans, transfer preview, `/metrics`, `/v1/me/player-wallets*` | #40–#57 | Additive. The optional ones are off by default (404 when off). |
| Twin ownership `heldByYou` | #57 | Additive and optional. Absent means "not stated". |
| No schema removed; no required property added to an existing response | all | — |

So **#59 is the only PR that removes API operations** (`/v1/wallet/*`). #55 is the one other
client-visible behaviour change on existing operations.

### Behaviour that is not in the contract

| Change | PR | Note |
| --- | --- | --- |
| `Idempotency-Key` honoured on every tenant write | #54 | Opt-in by header. Without it, nothing changes. |
| Rate limits can be shared through Redis | #53 | `RATE_LIMIT_STORE=memory` stays the default. |
| C# `SnapshotSync.SyncAsync(farmId, heldId)` replaced by `SyncAsync(FarmSnapshotState)` | #47 | Breaking for C# callers of the starter (none outside the repo). There is a migration snippet in `clients/unity-starter/README.md`. |
| C# ownership labels reworded (slot shown; "No current holders on chain"; "You hold this") | #52, #57 | UI text only. |
| `WALLET_ALLOWED_CHAIN_IDS` and `NEXT_PUBLIC_WALLET_CHAIN_ID` no longer read | #59 | Harmless if still set: unknown settings are ignored. `.railway/railway.ts` is untouched. |

### Database migrations

All four migrations in the stack are additive in effect. None drops, renames or rewrites existing data.

| Migration | PR | What it does | Destructive? |
| --- | --- | --- | --- |
| `0019_twin_foundation` | #40 | New tables `data_commitments`, `commitment_batches`, `commitment_batch_leaves` (RLS; SELECT/INSERT only for the app role). Replaces the `business_assets.kind` CHECK with a **wider** one: all six existing kinds kept, three added. | No. The constraint swap only widens and touches no rows. Its down migration refuses to run once data of the new kinds exists. |
| `0020_ownership_index` | #50 | New tables `chain_ownership_events` and `chain_ownership_cursors`; SELECT only for the app role. | No |
| `0021_idempotency` | #54 | New table `idempotency_records` (RLS) | No |
| `0022_player_wallets` | #57 | New tables `player_wallets` and `player_wallet_challenges`; nothing granted to the app role, and no reference to party wallets | No |

The EVM `wallet_links` and `wallet_nonces` tables (migration 0001) are **kept untouched**, with their
data, by owner decision. No migration drops or modifies them. The down migrations are blocked in
deployed environments (existing ops guard).

## 4. Manual verification runbook (devnet), for when staging is unblocked

**Preconditions (all owner actions):**
- The deploy hold is lifted for this exercise, and the stack (at least through #52 for J7, and through
  #57 for J8) is merged or deployed to staging.
- The worker build problem (issue #45) is resolved.
- `RWA_SOLANA_SIGNER_SECRET`, `RWA_TRON_SIGNER_PRIVATE_KEY` and `RWA_MAINNET_ENABLED` stay **unset/off**.
  `RWA_SOLANA_NETWORK=solana-devnet`.
- A devnet RPC endpoint that keeps full transaction history. It is a sealed platform secret: never put
  it in a URL that is logged, a ticket or the repository.

### J7: ownership from the chain

1. **Check the cluster by hand.** The ownership sources do not run the genesis check that the RWA
   engine runs. Call `getGenesisHash` on the endpoint and confirm the devnet hash
   (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`). Stop if it differs.
2. **Prepare test assets on devnet, outside the platform.** With an operator wallet and the Solana CLI:
   - create a Token-2022 mint, mint to wallet A, then transfer part to wallet B;
   - optionally, a Bubblegum V1 tree with one minted leaf.

   The platform signs nothing in this step.
3. **Register the chain identities** in a dedicated validation workspace. No API route writes them, so
   an operator inserts the `asset_representations` rows directly:
   - `SOLANA_TOKEN_2022` with `mint_address`;
   - for Bubblegum, `tree_id` pointing at a `merkle_trees` row with the tree's address, plus `das_asset_id`.
4. **Turn on reading only:**
   - api: `TWIN_OWNERSHIP_INDEX_ENABLED=true`;
   - worker: `TWIN_OWNERSHIP_INDEX_ENABLED=true` and `RWA_SOLANA_RPC_URL`;
   - scheduler: `TWIN_OWNERSHIP_INDEX_CRON`, for example every 10 minutes.
5. **Wait for one sweep.** Then expect one `ownership indexed` log line per asset, and a row in
   `chain_ownership_cursors` at a recent finalized slot.
6. **Read `GET /v1/tenants/{t}/twin/assets/{assetId}`.** Expect `status: indexed`,
   `source: chain_index`, `assurance: indexer_reported`, `asOfSlot` equal to the cursor, and holders A
   and B with amounts matching the explorer.
7. **Move tokens on chain and wait for another sweep.** Holders update, and `asOfSlot` advances.
8. **Negative checks:**
   - an asset whose mint has no history on the node stays `not_indexed`;
   - a wrong `tree_id` stays `not_indexed`;
   - stopping the RPC stores nothing.

   None of these may ever show "no holders".
9. **Record:** the slots, signatures and screenshots, in the J7 row of `plan.md` and in #52.

### J8: player wallets

1. **Turn on:** api `PLAYER_WALLETS_ENABLED=true`, and web `NEXT_PUBLIC_PLAYER_WALLETS_ENABLED=true`
   (a build-time value, so it needs a web build). `WALLET_AUTH_DOMAIN` and `WALLET_AUTH_URI` must match
   the web app's public host and origin.
2. **Link a real wallet.** In a browser with Phantom, Solflare or Backpack installed (devnet account),
   sign in and open **Your account → Player wallets**.
3. Choose **Link with <wallet>**. The wallet must show a **message** to sign: the domain, the address
   and the "does not authorise any transaction" statement. If the wallet asks to approve a transaction,
   stop: that is a failure.
4. **Expect** "Wallet ABCD…WXYZ linked". `GET /v1/me/player-wallets` lists it, and the audit log has
   `player_wallet.linked` with no address in it.
5. **Negative checks:**
   - rejecting in the wallet links nothing;
   - linking the same wallet from a second user gives 409;
   - waiting past `WALLET_NONCE_TTL_SECONDS` before signing gives "request a new one".
6. **"You hold this":** with J7 on and wallet A linked, the J7 asset reads `heldByYou: true`; with
   wallet B only, `false`. With J7 off, the field is absent.
7. **Separation from investor wallets:**
   - register the same address as an RWA party wallet; it must not appear under player wallets and
     must not change `heldByYou`;
   - linking a player wallet must create no `party_wallets` row.
8. **Unlink** from the account page. The list empties, and `heldByYou` disappears.
9. **Record:** the wallet, the browser and the result, against criterion 9 in `docs/player-wallets.md`,
   and in #57.

### Unity (separate machine)

Follow `clients/unity-starter/Validation/README.md` in the Unity 6 Editor, then in an IL2CPP player.
That covers J1, J5, and J8's label. This is still pending; CI covers only the engine-free core.

## 5. Security invariants

Each line was confirmed against the branches. The evidence says where.

| # | Invariant | Evidence |
| --- | --- | --- |
| 1 | **No key material is added or stored.** No new table, column or setting holds a private key; the new secrets are only `METRICS_TOKEN` (a bearer token, optional) and the existing auth secrets. | Non-test diff `main..#59` has no `Keypair`, `secretKey`, `privateKey`, `createPrivateKey`, `generateKeyPair` or `*_SIGNER_*` additions; migrations 0019–0022 reviewed above |
| 2 | **Nothing in the stack signs or submits a transaction.** The only signing-related words in the non-test diff are in a comment that says transaction features are never called. | The same diff search (`sign(`, `signTransaction`, `sendTransaction`, `signAndSend`); twin transfer preview uses `createTransactionSubmitter({ signerConfigured: false })` |
| 3 | **Verification only.** Player-wallet linking checks an Ed25519 signature made by the user's own wallet over a server-issued, single-use message; the platform holds no key. | `packages/chain/src/solana/player-wallet.ts` (`crypto.verify` only); `player-wallets.int.test.ts` |
| 4 | **Chain reads are read-only and finalized.** The ownership RPC client has only `getSlot`, `getSignaturesForAddress` and `getTransaction`, all at `finalized`. | `packages/chain/src/twin/solana-history-rpc.ts` |
| 5 | **Unity core is read-only by construction.** The transport has only `GetAsync`; nothing in Core can sign, submit or hold keys. `heldByYou` is only read. | `OwnershipAndSafetyTests` (reflection: `GetAsync` only; `NothingCanSignSubmitOrHoldKeys`) |
| 6 | **The web page never asks a wallet for a transaction.** It uses only `standard:connect` and `solana:signMessage`. | `apps/web/src/lib/player-wallets.test.ts`; `tests/e2e/player-wallets.spec.ts` (stand-in wallet offers transaction features; none called) |
| 7 | **Ownership is never inferred from platform records**; unknown is `not_indexed`, never "no owner"; fixture data is labelled test data. | `apps/api/src/routes/twin.ts`; `docs/ownership-index.md` acceptance table; C# tests |
| 8 | **Fail closed** on incomplete history, conflicts, wrong trees, foreign events and missing first-window mints. | `token2022-ownership-source.test.ts`, `bubblegum-ownership-source*.test.ts`, `ownership-index.int.test.ts` |
| 9 | **Player wallets and RWA party wallets are never derived from each other.** | Migration 0022 references no party table (schema test); "keeps player wallets and RWA party wallets apart" integration test |
| 10 | **Everything new is opt-in and off by default.** `TWIN_SNAPSHOTS_ENABLED`, `TWIN_SNAPSHOT_BATCHES_ENABLED`, `TWIN_OWNERSHIP_INDEX_ENABLED`, `PLAYER_WALLETS_ENABLED` and `NEXT_PUBLIC_PLAYER_WALLETS_ENABLED` default to `false`. The `TWIN_*_CRON` settings and `METRICS_TOKEN` are unset. `RATE_LIMIT_STORE` defaults to `memory`. | `packages/config/src/index.ts` |
| 11 | **Execution flags stay off.** `RWA_MAINNET_ENABLED` defaults to `false`. `RWA_SOLANA_SIGNER_SECRET` and `RWA_TRON_SIGNER_PRIVATE_KEY` are unset. The RWA engine builds a Solana or TRON rail only when a signer is set, so setting `RWA_SOLANA_RPC_URL` for J7 enables reading only. | `packages/config/src/index.ts`; `apps/worker/src/rwa/start.ts` |
| 12 | **Anchoring and transfers are plan or preview only** (`executable: false`). The Token-2022 retry decision is pure and not wired. TRON is untouched. | #43, #44, #58 |
| 13 | **Metrics expose no tenant data**: route templates and queue names only, behind a bearer token, 404 when off. | `apps/api/src/metrics.test.ts` |
| 14 | **No secrets in logs.** Authorization headers are redacted. Player-wallet audit events record the chain and outcome, not the address. | `packages/observability/src/logger.ts`; `apps/api/src/routes/player-wallets.ts` |

**Known gap, recorded rather than fixed:** the J7 ownership sources trust `RWA_SOLANA_NETWORK` and do not
verify the endpoint's genesis hash, as the RWA engine does. Runbook J7 step 1 covers it manually. A code
check is a small follow-up when J7 is next touched.

## 6. Deployment roadmap (each step needs the owner; nothing here is scheduled)

1. Review, mark ready and merge in the order of section 2.
2. Resolve the worker build (issue #45) before any worker deploy.
3. Deploy with every new flag off, so migrations 0019–0022 run and behaviour is unchanged apart from
   #55's paging and #59's removed routes. Confirm `/healthz`, `/readyz`, `/` and `/rwa`. Do the
   signed-in `/rwa` check.
4. J7 on devnet (section 4), then J8 with a real wallet (section 4).
5. Unity 6 Editor and IL2CPP validation, on a Unity machine.
6. Later, and only with separate decisions:
   - a metrics collector (examples in `docs/observability.md`);
   - wiring the Token-2022 retry decision (after the RWA execution holds lift);
   - dropping the EVM tables (a data-loss decision).
