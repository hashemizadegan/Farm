# Delivery plan: farm digital twin and game client

Living document. Update it in the same PR as the work it describes. The handoff record for the next
session is [`handoff.md`](handoff.md).

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
| J1 | A player opens a farm and sees its twin scene (boundary, plots, assets) | `GET …/twin/farms/{id}/scene` (#40) | Unity `FarmSceneLoader` (#40) | yes | API, Core: yes | Unity: **pending**. Staging: not deployed | no |
| J2 | A player inspects an asset: lifecycle, data commitments, ownership | `GET …/twin/assets/{id}` (#40) | Core `TwinReadClient`, `OwnershipDisplay` (#40) | yes | yes | pending | no |
| J3 | Anyone verifies an off-chain data item without trusting the API | commitments, batches, proofs (#40) | Core `Rfc9162CommitmentVerifier` (#40) | yes | yes | pending | no |
| J4 | The farm's state is captured as verifiable snapshots, manually or on a schedule (off by default) | snapshot API (#42), worker schedule (#43), scheduled batches (#44) | n/a | yes | yes | not on staging | no |
| J5 | The client keeps a farm current, verified, never rolling back, updating only what changed | content endpoint (#46) | Core `SnapshotSync`, `SnapshotDiff`, `SceneUpdatePlan` (#47); Unity `ApplySnapshotPlan` (#47) | yes | Core: yes (C# 61/61 on #48) | Unity: **pending** (package in #48) | no |
| J6 | A client proves a snapshot back to its batch root and a plan-only anchor | anchor plans (#43), chain check (#46) | Core `SnapshotChain`, `AnchorPlanReview` (#44, #46) | yes | yes | pending | no |
| J7 | **Ownership shown from the chain**: who holds an asset, as of which slot | Ownership index (events, cursors, index-backed reader, worker job, API wiring; all off by default): #50. Token-2022 event source from finalized RPC history: `feature/ownership-source-token2022`. **No Bubblegum source yet** | Core `OwnershipDisplay` treats `chain_index` as known ownership | index and Token-2022 source: yes. Bubblegum: no | see #50 and the next PR | not against a live cluster | no |
| J8 | A player links a Solana wallet and sees "you hold this" | not started | not started | no | no | no | no |
| J9 | Transfer or trade from the client | previews only (#40), unsigned intents (#41) | `DisabledTransferPreviewer` | previews only | yes | no | no |
| J10 | Batch roots anchored on-chain | plan-only (#43) | plan review (#44) | plan-only | yes | no | no |
| J11 | Operators see real-world assets in the web app (read-only `/rwa`) | existing RWA API | web `/rwa` (#39) | yes | yes | staging: pages load signed-out; **signed-in check pending** | staging, web only (`c02ae39d`) |

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

1. **J7 ownership index:** the index is #50; the Token-2022 source is on `feature/ownership-source-token2022` (docs/ownership-index.md). **Next:** a Bubblegum event source. Validating against a live devnet mint, and enabling on staging, need an owner decision and a deploy, which is on hold.
2. **J5 and J1 Unity validation:** run `clients/unity-starter/Validation/README.md` in Unity 6 (Editor, then IL2CPP) and fix any adapter failures. Blocked on a Unity environment.
3. **J8 wallet linking:** blocked on the product decisions below.
4. **J11:** finish the signed-in `/rwa` check once the owner opens the page.
5. **Roadmap items not started (PR #40 "Next PRs" 4–7):** reconcile Token-2022 and TRON attempts against the chain; API hardening (Redis-backed rate limits, idempotency keys on all writes, RWA pagination); metrics and alerts; retire the EVM wallet sign-in.

## Open product decisions

1. **Wallet linking (J8):** should a linked Solana wallet belong to the platform user (the game identity), to an RWA party (`party_wallets`), or to both? Is linking needed in the web app, the Unity client, or both?
2. **Older open PRs #16, #28, #30:** they are not drafts and predate this work. #30 looks superseded by #31 on `main`. Should they be converted to drafts or closed, or left as they are?
3. **Unity validation:** who runs it, on which machine and platform? Or should a Unity-capable machine be linked to a session?
