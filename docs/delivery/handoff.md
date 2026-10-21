# Handoff record

The latest entry is on top. Each entry records what was completed (with the exact verification), what
is blocked and why, and the next action. Scope and statuses are in [`plan.md`](plan.md).

## 2026-10-21, later (session 1, continued)

### Draft PR stack (all drafts, none merged)

`main` ← #40 … #48 ← #49 ← #50 ← #51 ← #52 ← #53 ← #54 ← #55 ← #56

| PR | Branch | Tested tip | CI run on that tip | C# |
| --- | --- | --- | --- | --- |
| #52 | `feature/ownership-source-bubblegum` | `de27621` | 39568045306: 14/14 | 63/63 |
| #53 | `feature/api-rate-limit-redis` | `0c4b096` | 39569203736: 14/14 | 63/63 |
| #54 | `feature/api-idempotency` | `a279c47` | 39569206824: 14/14 | 63/63 |
| #55 | `feature/rwa-pagination` | `5ce8aa7` | 39569208447: 14/14 | 63/63 |
| #56 | `feature/metrics` | `068c008` | 39569242035: 14/14 | 63/63 |

#56's tip moves with this handoff commit, which changes only the two delivery docs. #49–#51 are
unchanged from the entry below. Fixes are merged forward up the stack.

### Completed

- **J7 acceptance check** (`docs/ownership-index.md`, "Acceptance check"). Two gaps were fixed on #52:
  - the Unity label now names the slot, and "no current holders" is distinct from "not indexed";
  - the Token-2022 source refuses a first window without a mint, so missing history can no longer
    read as "no holders".
  - J7 is **fixture-tested only**; it has never run against a live cluster.
- **#53 fixed:** the Redis rate-limit tests sent requests before the connection was ready, so the
  requests were served unlimited (fail open). The tests now wait for the connection, and the threat
  model records the startup window.
- **#55, new:** keyset pages for the four RWA lists; the web `/rwa` page reads every page.
- **#56, new:** metrics for the API and worker (off unless `METRICS_TOKEN` is set) and alert rules
  (`docs/observability.md`).
- Owner decisions recorded in `plan.md`: #16, #28 and #30 unchanged; J8 open; Unity is a blocker.

### Blocked, and why

- **J7 live validation:** needs an owner-configured devnet RPC endpoint and a deploy (on hold).
- **Unity Editor and IL2CPP:** no Unity environment.
- **J8:** the wallet-ownership decision (`plan.md`, decision 1).
- **Roadmap item 4:** RWA execution and TRON holds (decision 2).
- **Roadmap item 7:** follows J8.
- **Metrics backend:** decision 3, then a deploy.
- **Signed-in `/rwa`:** waits for the owner.
- Staging is unchanged: the holds stay in place and `f14b940d` is untouched.

### Next action

No unblocked item in confirmed scope remains. Resume with whichever of `plan.md` decisions 1–3, J7 live
validation or Unity access arrives first.

## 2026-10-21 (session 1 of the delivery-owner mandate)

### Draft PR stack (all drafts, none merged)

`main` ← #40 ← #41 ← #42 ← #43 ← #44 ← #46 ← #47 ← #48 ← #49 ← #50 ← #51 ← #52

| PR | Branch | Tip | CI run on that tip | C# |
| --- | --- | --- | --- | --- |
| #40 | `feature/farm-metaverse-foundation` | `149d015` | 39493507369: 14/14 | 19/19 |
| #41 | `feature/farm-state-snapshots` | `03542e0` | 39493765635: 14/14 | n/r |
| #42 | `feature/twin-state-sync` | `a7fa07e` | 39496924758: 14/14 | 26/26 |
| #43 | `feature/twin-snapshot-schedule` | `72590ab` | 39499473536: 14/14 | 26/26 |
| #44 | `feature/twin-snapshot-batches` | `30947ee` | 39536081258: 14/14 | 30/30 |
| #46 | `feature/twin-snapshot-chain` | `4128911` | 39538586800: 14/14 | 38/38 |
| #47 | `feature/twin-verified-sync` | `b9fbf61` | 39540866024: 14/14 | 58/58 |
| #48 | `feature/unity-validation-kit` | `0d1ddcc` | 39543120912: 14/14 | 61/61 |
| #49 | `delivery/plan` | `d39d3fd` | 39543829354: 14/14 | 61/61 |
| #50 | `feature/ownership-index` | `3796361` | 39545019453: 14/14 | 61/61 |
| #51 | `feature/ownership-source-token2022` | `23e6c65` | 39545027199: 14/14 | 61/61 |
| #52 | `feature/ownership-source-bubblegum` | `f1f95c2` | 39545460643: 14/14 | 61/61 |

The #52 tip moves with this handoff commit; that commit only changes the two delivery docs.

"n/r" means the count was not recorded for that run. C# counts are read from the "Unity starter core
(C#)" job annotation; Vitest counts are not available, because job logs cannot be downloaded here.

### Staging (Railway project `melodious-liberation`, environment `production` used as staging)

| Service | Live commit | Notes |
| --- | --- | --- |
| web | `b59eaff` | Deployment `c02ae39d`, owner-authorized web-only deploy. `/` and `/rwa` return 200 signed out. The signed-in `/rwa` check is pending the owner. |
| API (`Farm`) | `b59eaff` | |
| worker | `55a06fa` | Failed `8942905` build during the Oct 20 Railway build incident. Investigation in issue #45. **Deploy on hold.** No worker code differs between `55a06fa` and `b59eaff`. |
| scheduler | `8942905` | |

- Staged patch `f14b940d` is still listed in pending work with zero changes, after a discard that Railway reported as applied. Do not touch it. A support note is drafted but not submitted.
- None of the draft PRs is deployed. Staging runs `main` only.

### Blockers

- **Unity Editor and IL2CPP validation:** no Unity environment. The package is ready in #48 (`clients/unity-starter/Validation/README.md`).
- **J7 live validation:** the ownership index and both sources (#50–#52) pass CI, including reference tests against the `mpl-bubblegum` serializers, but have not run against a live cluster. That needs a devnet RPC endpoint configured by the owner (`RWA_SOLANA_RPC_URL`, never committed) and a devnet mint and tree to index. Enabling on staging is a deploy and is on hold.
- **Wallet linking:** needs the product decision listed in `plan.md`.
- **Signed-in `/rwa`:** waits for the owner to open the page.
- **Everything that signs, submits, anchors or deploys:** blocked by the holds.

### Completed this session

- #48 verified (C# 61/61) and its description updated.
- #49: delivery plan and this handoff.
- J7 implemented and automatically tested: append-only ownership events and cursors (migration 0020, SELECT-only for the app role), an index-backed reader that reports `chain_index` / `indexer_reported` as of the cursor slot and fails closed on conflicts, a worker job and API wiring (off by default, `TWIN_OWNERSHIP_INDEX_ENABLED`), a read-only finalized-history RPC, and Token-2022 and Bubblegum V1 event sources that refuse incomplete reads.

### Next action

With no owner decision pending on J7, the next unblocked work is the roadmap items in `plan.md` "Next actionable work" 5, starting with API hardening (stacked on #52). J7 live validation, Unity validation, wallet linking and the signed-in `/rwa` check wait on the owner.
