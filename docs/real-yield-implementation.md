# Real-yield distribution: what this branch line implements, and what is gated

This line (ownership index: #50–#52 → #59 → #85 Y0 → #86 Y5 → … → Y15) carries the parts of the real-yield plan
(`docs/delivery/real-yield-distribution-plan.md`, revision 4, on the plan branch) that do not need the yield
domain library. The yield domain (Y1 cycle model, Y2 calculation, Y3 evidence, Y4 storage model, Y6 leaves and
proofs, the #84 multi-cycle harness) lives on the separate yield line (#60 … #84) and is **not mixed in here**.
Joining the two lines is an owner decision.

Everything below is off by default, simulation-only where it writes, and none of it signs, submits, funds or pays.

| Stage | What exists here | Switch (default) | Gate still outstanding |
| --- | --- | --- | --- |
| Y5 | slot-weighted holdings (D-12), weighted ownership input, D-17 service refusal, verified-RPC precedence over fixtures (F2) | ownership index stays off (`TWIN_OWNERSHIP_INDEX_ENABLED=false`) | D-12 real-cycle model; Y0 live use (deploy hold, J7 enablement, security sign-off) |
| Y7 | migration 0024: cycles, transitions, artifact sets, snapshots (D-17 layer 2), allocations, attestations, evidence, inputs; RLS | — (schema) | proposed security sign-off (RLS); D-31 confirmation |
| Y8 | operator read API, `yield:*` permissions (D-28) | — (permission-gated) | D-28 confirmation; D-30 before any public route |
| Y9 | preparer/reviewer workflow for simulation cycles; `calculate` freezes (D-11) | `YIELD_WORKFLOW_ENABLED=false`, refused in production | D-11 confirmation; **no calculation engine on this line** (503 `calculation_engine_unavailable`) until the lines are joined; every Real gate of plan §2.1 |
| Y10 | internal staff pages `/yield` | `NEXT_PUBLIC_YIELD_PAGES_ENABLED=false`, refused by the web build when `APP_ENV` is staging/production | D-39 for any non-staff audience |
| Y11 | Unity read-only yield DTOs | — | Unity 6 validation; D-39 |
| Y12 | account-to-party links (D-29) | `PARTY_LINKS_ENABLED=false`, refused in production | D-29 (L, P, T); [Legal] consent wording; proposed security sign-off |
| Y13 | holder's own allocations through an active link (partial) | `HOLDER_YIELD_ENABLED=false`, refused in staging/production | proofs and unsigned intents need the final Y6 leaves (D-26 [Ext]) and the line join; D-15, D-25, D-27, D-39 |
| Y14 | read-only record reconciliation of a cycle (partial) | — | economic reconciliation is the yield line's |
| Y15 | offline comparator: index holdings vs an explorer export at a slot | — (pure code) | **separate devnet approval**, deploy hold lifted, proposed S and O sign-off |
| Y6 final, Y16, Y17 | nothing here | — | D-26 [Ext] on-chain cost check; program audit and separate approval; all production approvals |

## Y15 runbook (not executed; needs the devnet approval first)

1. With the approval recorded, enable the ownership index for one devnet Token-2022 asset only, on a verified
   devnet endpoint (Y0 registers and re-verifies its genesis hash every batch).
2. Let the indexer reach a finalized slot `S`; read the asset's history with `readVerifiedOwnershipHistory`.
3. Export the explorer's holder balances for the mint at slot `S` (owner → base units).
4. Run `compareWithExplorer(asset, history.events, history.indexedThroughSlot, { slot: S, balances })`
   (`packages/chain`); record the result (`match`, or every differing owner) in the handoff.
5. No settlement, payout, funding or claim is exercised in Y15.
