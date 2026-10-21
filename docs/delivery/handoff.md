# Handoff record

The latest entry is on top. Each entry records what was completed (with the exact verification), what
is blocked and why, and the next action. Scope and statuses are in [`plan.md`](plan.md).

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
