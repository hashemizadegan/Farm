# Handoff record

The latest entry is on top. Each entry records what was completed (with the exact verification), what
is blocked and why, and the next action. Scope and statuses are in [`plan.md`](plan.md).

## 2026-10-21 (session 1 of the delivery-owner mandate)

### Draft PR stack (all drafts, none merged)

`main` ← #40 ← #41 ← #42 ← #43 ← #44 ← #46 ← #47 ← #48 ← (this plan) ← next work

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
- **Wallet linking:** needs the product decision listed in `plan.md`.
- **Signed-in `/rwa`:** waits for the owner to open the page.
- **Everything that signs, submits, anchors or deploys:** blocked by the holds.

### Next action

Start J7, the ownership index (see `plan.md`, "Next actionable work" 1), stacked on this branch.
