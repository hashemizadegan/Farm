# Delivery plan: farm digital twin and game client

Living document. Update it in the same PR as the work it describes. The handoff record for the next
session is [`handoff.md`](handoff.md).

**Merge order, breaking changes, the devnet runbook for J7 and J8, and the security invariants:**
[`readiness.md`](readiness.md).

## Product and sources of scope

A separate 3D farm client (Unity 6, URP) on the existing Farm platform. **Ownership** comes from the
chain as the source of truth. **Off-chain data** must be verifiable and reconstructable. The web app
stays the place for administration and operations. Sources of confirmed scope:

- PR #40 summary and "Next PRs"
- `docs/game-client.md` (client contract)
- `docs/twin-snapshots.md` (snapshots, batches, anchors, intents, and their "Next steps")
- owner approvals recorded in PRs #41–#48

Items marked *proposal* below are not confirmed scope.

## Status legend

| Status | Meaning |
| --- | --- |
| **Impl** | Implemented on a draft branch |
| **Auto** | Automated checks pass in CI on the tested commit |
| **Env** | Validated in the target environment (Unity 6 Editor or IL2CPP player, or staging) |
| **Dep** | Deployed |

CI success never counts as Env.

## User journeys

| # | Journey (user-visible outcome) | Backend | Client / UI | Impl | Auto | Env | Dep |
| --- | --- | --- | --- | --- | --- | --- | --- |
| J1 | A player opens a farm and sees its twin scene (boundary, plots, assets) | `GET …/twin/farms/{id}/scene` (#40) | Unity `FarmSceneLoader` (#40) | yes | API, Core: yes | Unity Editor and IL2CPP: **pending, blocked** (no Unity environment). Staging: not deployed | no |
| J2 | A player inspects an asset: lifecycle, data commitments, ownership | `GET …/twin/assets/{id}` (#40) | Core `TwinReadClient`, `OwnershipDisplay` (#40) | yes | yes | pending | no |
| J3 | Anyone verifies an off-chain data item without trusting the API | commitments, batches, proofs (#40) | Core `Rfc9162CommitmentVerifier` (#40) | yes | yes | pending | no |
| J4 | The farm's state is captured as verifiable snapshots, manually or on a schedule (off by default) | snapshot API (#42), worker schedule (#43), scheduled batches (#44) | n/a | yes | yes | not on staging | no |
| J5 | The client keeps a farm current, verified, never rolling back, updating only what changed | content endpoint (#46) | Core `SnapshotSync`, `SnapshotDiff`, `SceneUpdatePlan` (#47); Unity `ApplySnapshotPlan` (#47) | yes | Core: yes (C# 63/63 on #52–#56) | Unity Editor and IL2CPP: **pending, blocked** (no Unity environment; package in #48) | no |
| J6 | A client proves a snapshot back to its batch root and a plan-only anchor | anchor plans (#43), chain check (#46) | Core `SnapshotChain`, `AnchorPlanReview` (#44, #46) | yes | yes | pending | no |
| J7 | **Ownership shown from the chain**: who holds an asset, as of which slot | Ownership index (events, cursors, index-backed reader, worker job, API wiring; all off by default): #50. Token-2022 source (#51) and Bubblegum V1 source (#52), both from finalized RPC history | Core `OwnershipDisplay` shows `chain_index` as known ownership with its slot; "no current holders" is distinct from "not indexed" (#52) | yes | yes: fixture-tested (constructed events and RPC responses, mpl-bubblegum serializers); #50–#52 14/14. Acceptance check: `docs/ownership-index.md` | **pending**: never run against a live cluster. Unity: pending | no |
| J8 | A player links a Solana wallet and sees "you hold this" | Player wallets: challenge, Ed25519 proof, link/list/unlink (migration 0022), `heldByYou` on asset detail; off by default (#57) | Web account page links through the Wallet Standard (message signing only); Unity core reads `heldByYou` (#57) | yes | yes: API integration tests, web unit tests, C# 65/65, and Playwright in Chromium with an injected stand-in wallet (#57) | **pending**: no real wallet extension tried; Unity Editor and IL2CPP pending | no |
| J9 | Transfer or trade from the client | previews only (#40), unsigned intents (#41) | `DisabledTransferPreviewer` | previews only | yes | no | no |
| J10 | Batch roots anchored on-chain | plan-only (#43) | plan review (#44) | plan-only | yes | no | no |
| J11 | Operators see real-world assets in the web app (read-only `/rwa`) | existing RWA API | web `/rwa` (#39); reads every page of the paged lists (#55, not deployed) | yes | yes | staging (#39 only): pages load signed-out; **signed-in check pending** | #39 only: staging, web only (`c02ae39d`) |

## Platform hardening (PR #40 "Next PRs" 5 and 6)

Not a user journey, but confirmed scope. Each is implemented and tested on a draft PR, and none is deployed.

| Item | PR | Impl | Auto | Env | Dep |
| --- | --- | --- | --- | --- | --- |
| Redis-backed rate limits, shared across API replicas (`RATE_LIMIT_STORE=redis`, fail open) | #53 | yes | yes (Redis in the integration job) | no | no |
| `Idempotency-Key` on every tenant-scoped write (migration 0021) | #54 | yes | yes | no | no |
| Keyset pages for the RWA lists; web `/rwa` reads every page | #55 | yes | yes | no | no |
| Metrics (API, worker) and alert rules, off unless `METRICS_TOKEN` is set; future scrape and Alertmanager route documented only (decision 3) | #56 | yes | yes (PromQL syntax not checked: no `promtool` in CI) | no collector (by decision) | no |
| Retire the EVM wallet link (roadmap item 7) | #59 | yes | yes | no | no |

## Acceptance criteria (confirmed)

Detailed criteria live in each PR description. Cross-cutting rules that every slice must meet:

- **Read paths:** read-only by default; the C# transport is GET-only.
- **Fail closed:** nothing signs or submits; submission paths fail closed with a reason.
- **Ownership:** never inferred from database rows. Unknown ownership is reported as `not_indexed`, never as "no owner".
- **Verification:** every verification claim is re-checked on read. "Anchored" is never claimed without an on-chain check.
- **Scheduled and optional features:** off by default (`TWIN_SNAPSHOT_*` settings unset or `false`).
- **Engine boundary:** `Runtime/Core` stays engine-free (netstandard2.1, C# 9, warnings as errors), and its decisions are unit-tested.

## Holds (owner instructions; they block only work that crosses them)

- All PRs stay open drafts. No merges to `main`.
- No deployments and no Railway changes. The worker deploy is on hold (issue #45).
- Staged patch `f14b940d`: do not discard, commit or apply it. The support note is drafted, not submitted.
- No signing, secret access or disclosure, on-chain submission, mainnet, TRON or RWA execution.
- No production `FarmSnapshotPoller` unless separately authorized.

These holds block J9 and J10 entirely, and block J8 and J7 at deployment.

## Environment limitations

- The npm registry is unreachable from the build container. Local checks use a transpile shim. **CI is the authority** for lint, typecheck, Vitest, integration tests and the Docker builds.
- There is no .NET locally, so C# runs only in CI.
- There is no Unity anywhere available to this work. Unity Editor and IL2CPP validation need a human-run session (see `clients/unity-starter/Validation/README.md`).
- The build container cannot reach `*.up.railway.app`. Staging checks use Railway logs and web fetches.

## Next actionable work (in order)

Everything in confirmed scope that needs no external action is now implemented on draft PRs (#40–#59).
What remains waits on the owner, an environment or a hold:

1. **J8, a real wallet:** link with Phantom, Solflare or Backpack against a running web app and API with both J8 flags on. Needs a deploy (on hold) or a local run by the owner.
2. **J7 live validation:** needs an owner-configured devnet RPC endpoint and a deploy (on hold).
3. **J1, J5 and J8 in Unity 6** (Editor, then IL2CPP): `clients/unity-starter/Validation/README.md`. **Blocked: no Unity environment.**
4. **J11:** the signed-in `/rwa` check, once the owner opens the page.
5. **Token-2022 reconciliation, wiring:** `decideToken2022Retry` (#58) is offline only. Wiring it into the engine waits for the RWA execution holds to lift. TRON stays out of scope.
   - **Acceptance criteria (met offline):** a retry only after `expired`, past the blockhash limit at finalized, with no other unsettled attempt on the mint, and only when the signature and every state reading show the action did not happen. An exact change means `landed`, never retried. Any other change, or missing evidence, holds the intent.
6. **Metrics collector:** provision a Prometheus-compatible scraper and an Alertmanager-compatible route when operations decide to (examples in `docs/observability.md`).
7. **Retired EVM tables:** dropping `wallet_links` and `wallet_nonces` loses data, so it needs the owner.

## Owner decisions (2026-10-21)

1. **Wallet linking (J8).** Player-wallet linking and RWA party-wallet association are two distinct relationships.
   - A player wallet belongs to the platform (game) identity and is linked first through the web app. The Unity client may read the linked status, but never signs, manages keys or executes transactions.
   - An RWA wallet belongs to a compliance-screened RWA party (`party_wallets`). It is never inferred from a player wallet.
   - If one address is used in both domains, there are two explicit associations, with separate consent and validation.
   - No signing by the platform and no live-chain execution. The user's own wallet signs a one-time, off-chain message to prove control, as the existing EVM link already does; no transaction is involved.
   - **Acceptance criteria:** the ten criteria in `docs/player-wallets.md`.
2. **Token-2022 and TRON.** No live execution, retry submission, signing, RPC writes or RWA execution for TRON under the current holds. Token-2022 work is limited to offline design, pure state-machine logic, fixtures, unit tests and documentation: no credentials, signing, submission or live execution.
3. **Metrics.** Instrumentation and exposition stay Prometheus-compatible and collector-neutral. No collector is deployed or provisioned yet. Document a future Prometheus-compatible scraper and an Alertmanager-compatible alert route. Metrics stay opt-in and off by default.
4. PRs #16, #28 and #30 stay unchanged.
5. Unity validation stays pending until a real Unity 6 environment is available. It is recorded as a blocker, and independent work continues.

## Open product decisions

None at the moment.
