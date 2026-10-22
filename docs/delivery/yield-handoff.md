# Real yield distribution: handoff record

The latest entry is on top. Each entry records what was completed (with the exact verification), what
is blocked and why, and the next action. The plan is
[`real-yield-distribution-plan.md`](real-yield-distribution-plan.md) (revision 4, `f914af4`); its
§11.1 gates decide what may be built. This record is separate from [`handoff.md`](handoff.md), which
belongs to the frozen #40–#59 stack.

## 2026-10-22, 18:45 local (operator `/yield` preview: D-39 banner, sections, local run; CI 14/14 with Playwright on `565aaee`)

Owner instruction: enable and preview the operator UI locally. **D-39 is adopted for the simulation banner only**,
with the owner's wording.

**Commit `565aaee` on #96** (draft):
- **Banner:** the D-39 banner is mounted for every `/yield` route by `apps/web/src/app/yield/layout.tsx`. It is shown
  verbatim, in English in every locale.
- **Cycle-view sections:** read-only, each loading and failing on its own.
  - Four-eyes: preparer, attestations, approver, and separation.
  - Calculation dossier: new `GET …/simulation-dossier`, re-hashed on read.
  - Carry-in and carry-out per set.
  - The claim-intent batch from stored leaves, marked unsigned.
- **Local tooling:**
  - `pnpm seed:yield` (refused unless `APP_ENV` is development or test; idempotent) adds three simulation cycles to the
    demo workspace through the real workflow: Q1 and Q2 published with intent batches and carried dust; Q3 frozen,
    attested and awaiting approval.
  - `pnpm dev:yield` turns the three switches on for that run only.
  - `.env.example` documents the switches, commented out and off.
  - The runbook is in `docs/real-yield-implementation.md`.
- **Guards:** unchanged. The staging and production refusals hold for `YIELD_WORKFLOW_ENABLED` (production),
  `YIELD_CLAIM_INTENTS_ENABLED` and `NEXT_PUBLIC_YIELD_PAGES_ENABLED` (staging and production). Nothing is deployed,
  signed or submitted; no RPC is contacted.

**Verification:**
- **e2e** (`tests/e2e/yield-operator.spec.ts`, CI Playwright, chromium and mobile): the spec seeds, then walks the cycle
  list, the published Q2 and the frozen Q3.
  - It asserts the banner text, the statuses, the *Simulation* badges, four-eyes *Separated* and *Awaiting an
    approver*, the dossier, the carry, *Frozen*, and the unsigned intents table with rows.
  - It fails on any console error, page error or hydration message. It passed.
  - Screenshots are in the `yield-screenshots` artifact of run 39798832823 (2.1 MB).
- **CI:** 14/14 on `565aaee`, Playwright included.

**Limitations:**
- This sandbox cannot install npm packages, so no dev server was started here.
- GitHub's artifact storage is blocked from the sandbox, so the agent has not viewed the screenshots. The owner can
  download them from the run page.
- The linked Mac has no repository checkout connected, so nothing was run there.

**Gates:** unchanged. D-39 is adopted only for the simulation operator banner; holder, public and translated
disclosures remain open.

## 2026-10-22, 18:00 local (Y13 unsigned simulation claim intents on #96; CI 14/14 on `b5d40a7`)

**State verified:**
- #96: draft, unmerged; head was `bba14cc` before this slice and is `b5d40a7` after.
- main `b59eaff` is untouched.

**Commit `b5d40a7`** (based on `bba14cc`):

- **Intent shape (domain):** `packages/domain/src/yield/claim-intent.ts` defines `UnsignedClaimIntent` and
  `ClaimIntentBatch`.
  - Schemes `metafarm-yield-claim-intent/1` and `-batch/1`, both `version 1`, always `signed: false` and
    `simulation: true`.
  - Each intent references: cycle, version, set number, `artifactSetHash`, root, tree size, leaf index, hash and bytes,
    the stored proof path with its SHA-256, party, recipient, payout address, amount, payout mint, economic asset and
    network.
  - `createdAt` is the stored artifact's own time, so the batch is deterministic.
- **Migration 0029:** `yield_claim_intent_batches`.
  - Holds the canonical body; its SHA-256 is checked by the database.
  - One batch per approved set; unique on `(cycle_id, set_number, batch_sha256)`.
  - Its guard accepts only a published simulation cycle with its approved set, a body that names that set and cycle,
    is unsigned and simulation, and has one intent per stored leaf.
  - Append-only, with RLS.
- **API:** `POST` / `GET …/cycles/{cycleId}/claim-intents` (`yield:approve` to generate, `yield:read` to read).
  - Requires both `YIELD_WORKFLOW_ENABLED` and the new `YIELD_CLAIM_INTENTS_ENABLED`. Both are off by default
    (404); the new one is refused in staging and production by configuration.
  - Generation reads stored data only and recomputes nothing: the frozen artifact (its hash must equal the set hash),
    a simulation network, the tree matching the set, the stored leaf count, every proof re-verified, and every leaf
    decoded and matched to the artifact and the cycle.
  - `GET` re-hashes the stored body.
- **New stable codes:** `invalid_state`, `payouts_paused`, `non_simulation_network`, `nothing_payable`,
  `leaf_mismatch`, `intents_exist`. Reused: `real_gate`, `artifact_missing`, `artifact_mismatch`, `proof_invalid`.
  Refusals store nothing.
- **Documentation:** `docs/delivery/yield-adapter-shapes.md` §9 (shape, canonical example, rules, storage).

**Tests:**
- **Domain unit** (`claim-intent.test.ts`, 2/2): byte-identical output regardless of leaf order; a bound field
  changes the hash; malformed input refused.
- **Config:** the flag is off by default and refused in staging and production.
- **PostgreSQL end-to-end** (`apps/api/src/yield-pipeline.int.test.ts`, CI):
  - generate, with every intent equal to a stored leaf and its proof verifying;
  - rebuilding from the stored set gives the same SHA-256;
  - an idempotent retry replays; a second generate is refused with `intents_exist`; `GET` returns the stored batch;
    a role without `yield:approve` gets 403;
  - unpublished (`invalid_state`), disputed (`payouts_paused`) and real (`real_gate`) cycles are refused, and the
    routes are off (404) when not enabled;
  - a tampered stored proof (`proof_invalid`) and a deleted stored leaf (`artifact_mismatch`) are refused, with
    nothing stored. The tampering is done with owner rights and the append-only trigger off.
- **Not applicable:** a dossier-mismatch test. Intent generation reads no dossier; dossier mismatches are refused
  earlier, at `calculate` (tested in the engine suite).
- **Local:** unit suites green; 0029 up/down/up and its guard on scratch PostgreSQL 16; targeted tsc clean apart
  from known stub artifacts.
- **CI:** 14/14 on `b5d40a7`.

**Defects:** none found in this slice.

**Gates (unchanged; none crossed; no sign-off recorded):**
- D-26 [Ext] (Y6 final; the leaf context is simulation-only);
- D-15, D-25, D-27 and D-39 before any non-simulation intent, any holder-facing intent, signing or submission;
- D-30;
- confirmations of D-11, D-28, D-29 and D-31; the D-12 Real gate;
- proposed security sign-offs for Y0, Y5, Y7, Y12 and 0026–0029;
- Unity 6 validation;
- Y15 devnet approval and the deploy hold (#45);
- Y16 and Y17.

**Next action:** owner review of #96. Every safe simulation slice of Y5–Y15 is now built. What remains is behind the
gates above.

## 2026-10-22, 17:30 local (G1–G3 complete on #96; CI 14/14 on `bba14cc`)

**State verified:**
- #96 is a draft, unmerged, base #95 `49a419d`, head `bba14cc`;
- main `b59eaff` is untouched.

| Commit | Content |
| --- | --- |
| `d35bb4c` | G2 and G3: migrations 0027 and 0028, services, routes, tests. Its CI run was cancelled because a later push superseded it. |
| `0ef75ae` | G1: `docs/delivery/yield-adapter-shapes.md` (on the integration branch; line references pinned at `d35bb4c`, spot-checked at `bba14cc`) |
| `300ac80` | stage map in `docs/real-yield-implementation.md`. CI: Integration **failed** (test defect, below) |
| `bba14cc` | test fix. **CI 14/14 passed.** |

**G1, adapter shapes.** One reference document covering:
- the ownership snapshot, the leaf context, evidence items and categories, and the line/distribution taxonomy;
- the frozen artifact, the dossier, the Y5 weighted input and the engine contract;
- each shape's TypeScript definition with file and line range, canonical JSON examples from the repository's
  fixtures, invariants and refusal codes, and scheme/versioning notes.

It is documentation only.

**G2, frozen artifacts (migration 0027).**
- **Tables:** `yield_frozen_artifacts` and `yield_claim_leaves`.
  - `yield_frozen_artifacts` holds the canonical artifact text. The database checks that its SHA-256 equals the
    set's `set_hash`.
  - `yield_claim_leaves` holds the leaf bytes, hash and RFC 9162 path. Each leaf's root is the set's root, and its
    amount is its party's `allocated` row.
- **When rows are written:** only while the cycle is being calculated, for simulation cycles only. The tables are
  append-only, with RLS.
- **Calculate rule:** an added trigger means `calculate` needs the set's artifact and all its leaves. 0024 is
  unchanged.
- **Reads:** stored data only — `GET …/artifact-sets/{setId}/leaves`, re-verified, refused with `proof_invalid`,
  and the holder's `GET /me/yield/cycles/{cycleId}/proof` through an active link.
- **Preview** persists nothing.

**G3, carry-forward (migration 0028).**
- **Table:** `yield_carry_ledgers`, holding the canonical ledger-in and ledger-out with their SHA-256, checked by
  the database.
- **Predecessor rule:** a single SQL function, `yield_carry_source`, finds the latest published or closed
  simulation cycle of the same asset ending before this cycle starts; ties go to the highest version.
- **Chaining:**
  - carry-in must equal the predecessor's carry-out, by hash;
  - genesis carry-in is the canonical empty ledger;
  - an open intermediate cycle blocks the chain (`carry_predecessor_open`);
  - real cycles are refused.
- **Engine and calculate:** the engine takes carry-in only from the platform (`carry_from_dossier_refused`), and
  `calculate` needs the carry row.

**New refusal codes:**
- `artifact_missing`, `artifact_mismatch`, `proof_invalid`, `no_leaf`;
- `carry_source_mismatch`, `carry_source_missing`, `carry_mismatch`, `carry_predecessor_open`, `carry_missing`,
  `carry_from_dossier_refused`.

`carry_not_supported` is retired. Kept as before: `real_network_ownership`, the provenance separation, the
`simulation_only`/dossier refusals, `weight_exceeds_u64`, and the off-by-default and refused-in-production
switches.

**Determinism:**
- every persisted artifact is canonical text whose SHA-256 the database checks;
- the set hash is the artifact hash;
- carry is chained by hash;
- rows are append-only, and only written while calculating;
- recalculating unchanged inputs gives the same set hash under the next set number (tested).

**Defect found:**

| Defect | Classification | Cause | Fix |
| --- | --- | --- | --- |
| The G3 carry test read a preview with `GET` (404). | Test defect | `preview` is a `POST` route. | `bba14cc` |

**Local verification (sandbox):**
- 0024–0028 up, then 0028 and 0027 down and up again, on scratch PostgreSQL 16;
- guards exercised: `calculate` refused without the artifact and without carry, wrong artifact hash, non-genesis
  carry-in with no source, rows after calculate, edits;
- unit sweep: 50 of 53 files pass.

The three failing twin files fail identically on the pre-join tip `49a419d`. They are artifacts of the local `zod`
stub (repository/environment issue) and pass in CI.

**Remaining gates (unchanged; none crossed, no sign-off recorded):**
- D-26 [Ext] (Y6 final; the leaf context is simulation-only);
- D-15, D-25, D-27 and D-39 before any non-simulation Y13 intent;
- D-30;
- confirmations of D-11, D-28, D-29 and D-31; the D-12 Real gate;
- proposed security sign-offs for Y0, Y5, Y7, Y12 and 0026–0028;
- Unity 6 validation;
- Y15 devnet approval and the deploy hold (#45);
- Y16 and Y17.

**Next action:** owner review of #96. The next safe slice is the Y13 unsigned simulation claim intents over the
persisted leaves. They are leaf data only, with no rail-specific fields. Compliance checkpoint 1 is recorded, and
intents stay off and refused when deployed.

## 2026-10-22, 15:00 local (G1–G3 started: adapter shapes, frozen artifacts, carry-forward)

Verified before any change:
- the `integration/yield-ownership-join` worktree is clean;
- local HEAD = origin = PR #96 head = `649ca706d86abdb8e88a30211a93011d311101ad`;
- #96 is an open, unmerged draft;
- `main` = `b59eaff`, untouched.

Work continues on the #96 branch (the established pattern for the integration). Results are recorded in the next
entry.

## 2026-10-22, afternoon (line join done: integration PR #96, engine wired)

| Item | Value |
| --- | --- |
| Integration branch | `integration/yield-ownership-join` (worktree `/home/claude/farm-int`) |
| Draft PR | #96 (base `feature/devnet-verification-harness` = #95) |
| Pre-merge tips | ownership line #95 `49a419db00143d101e019db47973c31aa50f4531`; yield line #84 `0a5783cd5072e58e0a825cbbd1bae03f7776bd3b` |
| Merge commit | `b5f87ea` (no conflicts; no file changed on both lines since `ebb3f56`) |
| Engine wiring and tests | `649ca70` |
| CI | 14/14 passed on `649ca70` |

#84 and #95 were not modified; nothing merged to main; nothing deployed or enabled; no RPC contacted.

**Engine wiring scope:**
- `createPipelineYieldEngine` runs the yield domain's `calculateSimulationCycle` as the Y9 `calculate`/`preview`
  engine, for simulation cycles over **fixture** ownership.
- A per-cycle simulation dossier supplies the typed records the tables lack:
  - domain `simulation-dossier.ts`;
  - migration 0026: content-addressed, append-only, simulation draft cycles only;
  - checked against the locked cycle line by line.
- **Kept fail-closed:**
  - devnet RPC ownership is refused (`real_network_ownership`), because the yield-line snapshot accepts simulation
    networks only;
  - also refused: real cycles, a missing or incomplete dossier, a mismatching dossier, u64 overflow, and
    cross-cycle carry.
- The workflow remains off by default and refused in production. 0024 and 0025 are unchanged.

**Tests added:**
1. 0024 ↔ Y1 transition, state and four-eyes sync (`packages/db/src/line-join-sync.test.ts`).
2. No silent fixture/RPC mixing across the join (`apps/api/src/line-join-provenance.test.ts`).
3. Calculate → freeze stability under preview, idempotent retry, refused re-calculate, unlock/recalculate (same
   set hash, next set number) and versioning (`apps/api/src/yield-pipeline.int.test.ts`, PostgreSQL), plus the
   engine unit suite (`apps/api/src/yield-pipeline-engine.test.ts`).

**Local results:**
- new tests 6/6, 3/3, 3/3;
- yield pipeline 21/21, multi-cycle 10/10, cycle 14/14;
- Y5/Y7/Y12 unit suites green;
- 0026 up/down/up and its guards on scratch PostgreSQL 16.

**Defects found:** two test defects, fixed before push:
- regenerated event signatures were treated as the same input;
- an over-broad SQL regex.

None are open.

**Sandbox limits:** no PostGIS, .NET or npm registry access, so integration, C#, full typecheck and lint ran in CI
only. The local unit harness stubs `pg`, `zod` and `fastify`, and now resolves `@metafarm/<pkg>/<subpath>`.

**Remaining gates (none crossed; no sign-off recorded):**
- D-26 [Ext] on-chain hash cost check (Y6 final; the leaf context is simulation-only);
- Y13 Merkle proofs and unsigned intents (D-15, D-25, D-27, D-39);
- D-30 public route; D-39 wording;
- confirmations for D-11, D-28, D-29 and D-31; the D-12 Real gate;
- proposed security sign-offs for Y0, Y5, Y7 and Y12 (and the new 0026);
- Unity 6 validation;
- Y15 devnet approval and the deploy hold (#45), which also unblock RPC ownership in the pipeline;
- Y16 and Y17 approvals.

**Exact next action:**
- Owner review of #96.
- Then, for the next safe slice:
  - persist the frozen cycle artifact (or its leaves and proofs) at `calculate`, so Y13 proof reads need no
    recomputation;
  - persist the cross-cycle distribution ledger, so `carry_not_supported` can be lifted for simulation cycles.
- Both are simulation-only and need no new decision.

## 2026-10-22, 14:20 local (line join, Option A: verified state before any change)

Owner decision (this message): **join the lines, Option A.** One integration branch off the ownership-line tip
(#95), with the yield-line tip (#84) merged into it, as one draft PR.

**Verified on GitHub and locally (before any change):**

| Item | Value |
| --- | --- |
| #84 (yield line tip) | draft, open, unmerged; head `feature/yield-multi-cycle` @ `0a5783cd5072e58e0a825cbbd1bae03f7776bd3b`; base `feature/yield-shared-16k-cycle` @ `703caac` (#80) |
| #95 (ownership line tip) | draft, open, unmerged; head `feature/devnet-verification-harness` @ `49a419db00143d101e019db47973c31aa50f4531`; base `feature/yield-reconciliation` @ `7298c53` (#94) |
| Common ancestor | `ebb3f56` (#59, contains J7 #50–#52) |
| Ancestry | neither tip contains the other; `main` is an ancestor of both |
| `main` | `b59eaff`, last commit 2026-10-20; untouched |
| Merged PRs | none from #40 onward (the merged ones are #1–#39) |
| Files changed on both lines since `ebb3f56` | none, so no textual conflicts are expected |

## 2026-10-22, evening (Y5–Y15 implemented on the ownership-index line; stopped at the gates)

Machine-readable: `yield-run-summary-2026-10-22.json`. Decisions: D-12 (Build) and D-17 owner-approved;
D-31, D-28, D-11, D-29 applied as documented recommendations, **not sign-offs**
(`decision-adoptions-2026-10-22.md`). Security notes: `y5-y7-y12-security-notes.md` (not a sign-off).

| Stage | PR | Branch | Base | Head | CI |
| --- | --- | --- | --- | --- | --- |
| Y5 slot-weighted holdings, F2 precedence | #86 | `feature/ownership-holding-weights` | #85 | `c3abaf3` | 14/14 |
| Y7 schema 0024, D-17 layer 2 | #87 | `feature/yield-schema-core` | #86 | `3c0cf4b` | 14/14 |
| Y8 operator read API, `yield:*` | #88 | `feature/yield-operator-api` | #87 | `f1789f8` | 14/14 |
| Y9 simulation workflow (no engine: 503) | #89 | `feature/yield-workflow` | #88 | `8c1b9cf` | 14/14 |
| Y10 internal pages (flag, refused when deployed) | #90 | `feature/yield-internal-pages` | #89 | `652605c` | 14/14 |
| Y11 Unity DTOs | #91 | `feature/yield-unity-read-models` | #90 | `3c2912d` | 14/14 |
| Y12 account-to-party links, 0025 | #92 | `feature/party-account-links` | #91 | `f3fcc8e` | 14/14 |
| Y13 holder allocations (partial) | #93 | `feature/holder-yield-allocations` | #92 | `f5eb3cf` | 14/14 |
| Y14 record reconciliation (partial) | #94 | `feature/yield-reconciliation` | #93 | `7298c53` | 14/14 |
| Y15 offline comparator + runbook | #95 | `feature/devnet-verification-harness` | #94 | `49a419d` | 14/14 |

All drafts; nothing merged, deployed or enabled; no RPC contacted; nothing signed. The yield line (#60–#84) is
untouched and not mixed in.

**Local verification:**
- unit tests through the stub harness;
- SQL for 0024 and 0025 exercised on scratch PostgreSQL 16 (up, down, up; lifecycle, four-eyes, D-17, real gate,
  append-only, RLS);
- the targeted tsc check.

Integration, C#, full typecheck, lint and OpenAPI lint ran in CI only (no PostGIS, .NET or npm in the sandbox).

**Defects found and fixed:**
- implementation: F2 combined-source labelling; Y7 creation-log FK; inherited transition actor; OpenAPI flow-mapping
  comma;
- test: raw-error mapping, insertion order, a lint import, the revoked-link error code.

None are open.

**Stopped at:**
- the line join (an owner decision, needed for the calculation engine, final leaves, proofs, intents and economic
  reconciliation);
- D-26 [Ext] (Y6 final);
- the devnet approval (Y15 live);
- Y16 and Y17 approvals;
- the confirmations and sign-offs listed in the JSON.

**Next action after the gates:** see `next_action_after_final_gate` in the JSON.

## 2026-10-22, 13:30 local (state check; Y0 security review and fix; D-12 and D-17 briefs; remaining work)

**Verified state (GitHub API and git ancestry):**

| PR | Head | Base | CI |
| --- | --- | --- | --- |
| #84 | `0a5783c` | #80 `703caac` | 14/14 passed |
| #85 | `20ccaae` (was `243191b`) | #59 `ebb3f56` | 14/14 passed; run 39744219837 for `20ccaae` |

- Both are open drafts and unmerged, on separate branch lines.
- #85 contains #59 and #52. #84 does not contain #85.
- #84 recorded scope unchanged; not reworked.

**Y0 security review:** `y0-security-review.md` (input to the proposed security sign-off; not a sign-off).
- **F1, Medium (latent):** pre-0023 RPC rows could make the reader serve partial history. Reproduced on
  PostgreSQL 16. **Fixed in `20ccaae`:**
  - an unbound cursor is ignored, so the asset is re-indexed from the start;
  - its slot is replaced, not kept as a lower bound;
  - identical re-observed rows are bound to the verified identity.
- **F2, Medium (pre-existing):** fixture and RPC rows can coexist for one asset; left to D-17.
- **F3, Low:** the start-up registration error log lacked a message. Fixed in `20ccaae`.
- **F4–F8, Info:** self-reported genesis hash; IPv6 hosts refused; `NOT VALID` clean-up note; verification
  latency; the app role can read provider host names.
- **Checks passed:** registration, endpoint sanitisation, permissions, constraints, binding, transaction boundary,
  fail-closed defaults.

**Tests for `20ccaae`:**
- local: worker unit 7/7, schema 5/5, chain 18/18; targeted tsc clean on the changed files;
- PostgreSQL 16: before/after reproduction of F1, cursor replacement, row binding, replay, fixture non-binding;
- CI: 14/14, including the new integration test for pre-0023 rows.

**Decision briefs** (OPEN — FOR REVIEW ONLY, no approvals assumed):
- `decision-brief-d12-holding-model.md`: recommends **slots** (Option A) for the Build gate; the model choice
  (Real gate: P, T, L) stays open. It notes that slot weights can exceed the u64 `rawShares` of #75, so Y5 needs a
  weighted ownership input.
- `decision-brief-d17-fixture-exclusion.md`: recommends **all three layers**, staged: service and tests in Y5,
  database in Y7. It raises F2 for the owner to settle.

**Remaining work, dependency-ordered (plan §11.1 and §12.2):**

1. **Unblocked now** (no open decision; owner authorisation only):
   - Y0 review fixes: done (#85, `20ccaae`).
   - Simulation-only pre-work that claims no stage: done (multi-cycle harness, #84).
   - No other Y-stage is both decision-free and approval-free. Y10 internal pages and Y11 need no decision but
     depend on Y8.
2. **Blocked on D-12 and/or D-17:**
   - **Y5:** D-12 Build + D-17. Y0 is implemented.
   - **Y7:** D-17 + D-31, after Y0–Y6.
   - Then, in order:
     - **Y8:** D-28;
     - **Y9:** D-11 confirmation;
     - **Y10 and Y11:** depend on Y8 (D-39 before any non-staff audience);
     - **Y12:** D-29;
     - **Y13:** Y12, Y6, Y9 (D-15, D-25, D-27, D-39 before non-simulation intents);
     - **Y14:** Y9 and Y13.
   - **Y6 final:** D-26. The simulation code already exists in #70 and #71.
3. **Needs security sign-off or explicit operational approval:**
   - **Y0 live use:** deploy hold lifted, J7 enabled, proposed security sign-off, a full-history node.
   - **Y4 real adapter:** [Legal] data-protection review, D-24.
   - **Y7:** proposed security sign-off for RLS.
   - **Y12:** proposed security sign-off.
   - **Y15:** devnet approval and the deploy hold.
   - **Y16:** separate approval and audit.
   - **Y17:** all production approvals.
   - **Real attestations:** D-23.

**Next code step:** none is available without a decision. Y5 needs D-12 (Build) and D-17.

**Holds unchanged:** no merges, deployments or enabling of ownership indexing; no execution, signing, TRON,
mainnet, Railway or deployment change; drafts only.

## 2026-10-22, 12:30 local (Y0 implemented: verified cluster identity, D-16 option A)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #85 | Y0: verified cluster identity for ownership sources | `feature/ownership-cluster-identity` | `243191b` | #59 (`ebb3f56`, contains J7 #50–#52 unmodified) | 39741042292 (attempt 3) | 14/14 passed |

**Owner decision:** D-16 approved as **option A** (the brief, `decision-brief-d16-cluster-identity.md`). The brief's
status line is left as written, as the record of what was proposed. **Y0 is on the ownership-index line, not on
the yield stack (#75–#84).**

Commits: `5628678` (chain), `f8281fe` (db, migration 0023), `243191b` (worker, tests, docs).

**Y0 scope covered (plan §11.1 row Y0):**
- **Verify the RPC cluster:** `verifyClusterIdentity` (`packages/chain/src/solana/cluster.ts`) reuses the existing
  `getGenesisHash` check. It returns `{ network, genesisHash, endpointScheme, endpointHost }`; a mismatch carries
  the expected and actual hashes. `verifySolanaCluster` is unchanged in behaviour.
- **Record the verified identity:** migration `0023_ownership_source_identities`.
  - Columns: network, genesis hash, endpoint scheme, endpoint host, `verified_at`, `verified_by`,
    `last_verified_at`.
  - No credentials, tokens, paths or query strings: the host check refuses `/`, `?`, `#`, `@` and whitespace.
  - The genesis hash is pinned per network label by a check.
  - Read-only for the application role. Down migration included.
- **Bind sources and cursors to it:** `source_identity_id` on `chain_ownership_events` and
  `chain_ownership_cursors`.
  - A composite foreign key on (id, network) allows only an identity of the row's own network.
  - `rpc` rows require an identity and `fixture` rows refuse one (`NOT VALID`, so pre-Y0 rows don't block the
    migration).
  - `readOwnershipIndex` never serves unbound `rpc` rows.
- **Reject mismatches:**
  - The worker registers the identity at start-up. Each batch verifies **before and after** reading (same
    identity, job's network), then stores the identity, events and cursor in one system transaction.
  - A missing guard, a mismatched, unavailable or invalid endpoint, another network, or an identity change
    during the batch writes nothing and does not move the cursor.
  - The error is `OwnershipSourceIdentityError` with a stable `code` and the expected and actual genesis hashes,
    which are also logged.

**Tests:**
- Chain: 18/18 locally.
- Worker unit: 7/7 locally; refusals happen before the database is touched.
- Schema from SQL: 5/5 locally.
- Worker integration: in CI's PostGIS job (passed). Not runnable locally (no `pg` package).
- Locally against PostgreSQL 16 (migrations 0020 + 0023):
  - 28 constraint checks;
  - pre-Y0 rows tolerated;
  - repository statements (idempotent registration, forward-only cursor, unbound rows not served);
  - down → up.
  - This caught an index-name clash with 0020 before the push.

**CI note:** attempts 1 and 2 failed in all four Docker builds (`pnpm install` inside the image). No manifest,
lockfile or Dockerfile changed, a control re-run of #84's Docker build passed, and attempt 3 passed. Treated as
transient.

**Still gated:** live use needs the deploy hold lifted and J7 enabled by the owner (`TWIN_OWNERSHIP_INDEX_ENABLED`
off by default; no RPC contact unless enabled). Proposed security sign-off (§11.2). Y5 also needs D-12 and D-17.
No execution, signing, TRON, mainnet enablement, Railway or deployment change; drafts only.

## 2026-10-22, 11:00 local (#84 hardened; D-16 decision brief)

| PR | Head | CI run | Checks |
| --- | --- | --- | --- |
| #84 | `0a5783c` | 39735597866 | 14/14 passed (unit job 149 s, test step 118 s) |

- **#84 hardening** (tests only; no pin changes and no new pins):
  - `ChainServingError` with stable codes and messages: `stale_cycle`, `unknown_cycle`, `unknown_version`,
    `version_gap`, `version_not_monotonic`, `invalid_version`.
  - `PublishedVersionsIndex`: per cycle id, versions must be exactly 1, 2, 3, …. A gap (v3 without v2) is refused
    with `version_gap`; a repeat or an older version with `version_not_monotonic`. Nothing is removed, so the
    latest version is monotonic.
  - Serving a stale cycle 3 (cycle 2 v2 published, cycle 3 not rebuilt) fails with `stale_cycle`, message:
    `refusing to serve cycle <c3> v1 is stale: based on <c2> v1, latest is v2`. Cycle 3 v1 opened by explicit
    version still serves verified claims (audit read).
- **D-16 brief:** `decision-brief-d16-cluster-identity.md`, OPEN — FOR REVIEW ONLY.
  - Recommends **Option A**: a genesis-hash identity table referenced by cursors and events, NOT NULL for `rpc`
    rows, verified at registration and before every batch.
  - Approving it unblocks Y0 on the J7 line (base #59, on top of #50–#52), not on the yield stack.

## 2026-10-22, 10:30 local (multi-cycle simulation harness; cycle 2 correction)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #84 | multi-cycle simulation harness with carry-forward and a correction (tests only) | `feature/yield-multi-cycle` | `7d70e45` | #80 | 39733082488 (2 attempts) | 14/14 passed |

Owner go-ahead for the decision-free simulation track. This is pre-work towards Y14, which formally depends on Y9
and Y13; it claims no plan stage. It adds two test files only: no production code, vitest config, C# client or
existing pin changes. **#84 is now the tip of the stack.**

**Harness API** (`packages/domain/src/yield/multi-cycle.test-support.ts`):
- `new SimulationChain({ holders, profile, distributionPolicy, cycles: [{ cycleId, ownershipSeed, slot,
  evidenceLines? }] })` refuses non-simulation policy records.
- `publishAll()` publishes version 1 of each cycle in order.
- `correct(index, { evidenceLines }, { rebase = true })` publishes version v+1 of the same cycle id, then rebases
  every later cycle.
- `latest(id)`, `history(id)` and `latestChain()` return published versions:
  `{ cycleId, version, basedOn, ledgerIn, ledgerOut, ownership, evidenceLines, artifact, artifactSha256 }`.
- `chainProblems()` reports stale or broken carry links.
- `open(id, version?)` opens the read model: the latest version by default, refused if stale; any version
  explicitly, for audit.
- `store` is one immutable claim read-model store holding every published version.

**Seeds and profiles** (`CHAIN_DEFAULTS`):
- 3 cycles (`…c0001`, `…c0002`, `…c0003`) × 4,096 holders, `uniform` profile.
- Ownership seeds `0xc1c1e` / `0xc2c2e` / `0xc3c3e`; slots 300,000,000 / 300,500,000 / 301,000,000.
- Every 61st holder withheld; 2 unattributed.
- Distribution policy (simulation status): `remainder: "carry"`, `dustThreshold: 1,000,000`, withhold missing
  wallets.
- Correction `CYCLE2_CORRECTED_LINES`: USD revenue 800,000 → 850,000 minor units.

**Invariants:**
- **Per version:** inflow (settlement + carried remainder in + Σ deferred dust in) = claims + deferred dust out +
  withheld + unattributed + carried remainder out. The plan's ledger in is exactly the ledger passed in.
- **Carry applied exactly once:**
  - every carried-in deferred amount is its party's `deferredIn`, or is carried out unchanged if the party has no
    share this cycle;
  - no `deferredIn` appears that was not carried in;
  - cycle k+1's ledger in is the same object as cycle k's ledger out.
- **Chain:** Σ settlement = Σ (claims + withheld + unattributed) + final carry. This holds for the corrected chain
  (1v1, 2v2, 3v2) and for the superseded original chain (1v1, 2v1, 3v1).

**Correction semantics (latest wins):**
- A correction is a new version of the same cycle id, with a new artifact hash.
- Later cycles are rebased as new versions on the corrected history, keeping the same snapshot and evidence; only
  the carried-in ledger changes.
- The read model serves the latest version of each cycle (1v1, 2v2, 3v2). On 256 seeded holders per cycle, its
  results equal the in-memory lookup of the latest artifact.
- Superseded versions stay readable by explicit version.
- A stale downstream cycle (correction without rebase) is reported by `chainProblems()` and refused by `open()`.

**New pins** (deterministic; nothing existing changed):

| Cycle | Version | Artifact hash |
| --- | --- | --- |
| `…c0001` | 1 | `77f3a1db722a7b7f606903c16c1b33cf6dea5362e192faccf6805cf019ea4b24` |
| `…c0002` | 1 | `36e1d5c1f791fa48844389bc6a3cf899cc528bd818b70b210fe874673e527ac6` |
| `…c0003` | 1 | `e3a4fb122bd9b0ce210d9a2c6896b02eb6b8ae18e44663b26d78ad9a7ed649ac` |
| `…c0002` | 2 | `aa5ec40817b7cb30b2993a30d755e382a110ad5d47017fe60c800b455cb2b189` |
| `…c0003` | 2 | `3d2bc4d779888cc59bf2dbe31d5151063fbb60ca7727803d07fd395de076cf28` |

Multi-version store image: `12b0dae6ba8e10fbd4780bfa076e50e58dc9813fe1e0b137358eb7e335e40d4d`, 18,997,154 bytes.

**Runtime:**
- Locally the file runs in about 43–44 s (6/6, twice, separate processes, same pins).
- CI unit job: 196 s (test step 123 s) on attempt 1, then 87 s (60 s) on attempt 2. This is within the runner
  variance measured in the #80 bisect.

**Holds unchanged:** simulation only; no chain, network, storage, signing, TRON, mainnet, Railway, deployment or
merge.

## 2026-10-22, 09:45 local (current tip: #80 validated; next milestone)

**Current validated tip of the yield stack: #80, `feature/yield-shared-16k-cycle` @ `703caac`.**

- **CI:** 14/14 passed on run 39715678632, attempts 2–5. Attempt 1's Dependency audit failure was transient.
- **#80's diff against #79** touches four test files only (`claim-read-model.test.ts`, `large-holder-envelope.test.ts`,
  `large-holder-memo.test.ts`, `large-holder.test-support.ts`). It changes no production code, configuration or
  `clients/` files.
- **Invariants intact:**
  - leaf layout 2 (233 bytes; layout 1 vectors authoritative);
  - RFC 9162 proofs and path lengths;
  - read-model pins: 4,096 holders `79f1704f…` / 4,067,466 bytes; 16,384 holders `4c0ff458…` / 16,412,652 bytes;
  - the #78 4,096-holder artifact pin `3e374c9b…` / 7,487,231 bytes;
  - C# cross-stack parity: claim-tree vectors, claim payloads, tiny-holders, large-tree and read-model samples.
- **Stack status:** all open drafts, none merged; `main` untouched (`b59eaff`).

  | PR | Head |
  | --- | --- |
  | #75 | `64187cd` |
  | #76 | `670d624` |
  | #77 | `ba3b7f0` |
  | #78 | `db3bbe0` |
  | #79 | `cf10f41` |
  | #80 | `703caac` |

- **Not part of this stack:** three non-draft PRs (#16, #28 "RWA: sign with Google Cloud KMS", #30) predate the yield
  work. They are listed for awareness only.
- **Holds unchanged:** execution, signing, TRON and mainnet off; simulation defaults only; fail-closed safeguards in
  place; no Railway or deployment change (worker hold #45; staged patch `f14b940d` untouched).

### Next milestone (plan revision 4, §11.1)

Every remaining Y-stage needs an owner decision before it may be built:

| Stage | Blocked by |
| --- | --- |
| Y0 (cluster identity) | D-16 |
| Y5 (allocation from verified ownership events) | Y0; D-12, D-17 |
| Y6 (canonical leaves, final) | D-26 |
| Y7 (schema, append-only, RLS) | D-31, D-17 |
| Y8 (operator read API) | D-28 |
| Y9 (preparer and reviewer workflow) | D-11 confirmation |
| Y10, Y11 (web and Unity read models) | Y8 |
| Y12, Y13 (login-to-party link; holder-facing allocations and unsigned intents) | D-29; D-15, D-25, D-27, D-39 |
| Y14 (simulation and reconciliation tools) | Y9, Y13 |
| Y15–Y17 (devnet, program, live) | separate approvals |

The Y4 real adapter also needs the [Legal] data-protection review, and D-23 (attester identity) is open.

**Recommended next milestone: owner decisions, group 1 (§12.2)**, in this order:
1. **D-16** unblocks Y0, the verified ownership index that would replace the supplied snapshot.
2. **D-12 and D-17** unblock Y5.
3. **D-26** confirms the claim-tree hash. The simulation code already runs on `sha256-rfc9162-double-leaf/1`, so D-26
   would ratify or replace it.
4. **D-31 and D-28** unblock Y7 and Y8.
5. **D-11** unblocks Y9.

**Decision-free simulation track, if wanted while decisions are pending:** a multi-cycle simulation harness.
- Chain consecutive simulation cycles (cycle N's ledger out becomes cycle N+1's ledger in).
- Check conservation across cycles: carried dust, carried remainder, withheld and unattributed amounts.
- Cover a published correction superseding a cycle (§2.4) and the read model serving the latest version.
- Pure and simulation-only. It is pre-work towards Y14, which formally depends on Y9 and Y13, so it would be
  flagged as pre-work and would not claim a plan stage.
- Not started; it needs the owner's go-ahead.

## 2026-10-22, 08:30 local (CI timing bisect for #80: runner variance, no code-level overhead)

Owner asked to isolate the ~25–30 s unit-job overhead of #80 (`703caac`) relative to #79 (`cf10f41`).

**Method:** three variants of `703caac`, each in a diagnostic draft PR based on the #79 branch, so CI ran exactly
#80 + one change. They ran in two concurrent rounds with fresh runs of #79 and #80 as controls. Test code only; no
production, config or deployment changes.

`pnpm test:unit` step (unit job wall clock is about 25–35 s more, for setup and install):

| Code | Variant | Round 1 | Round 2 | Earlier |
| --- | --- | --- | --- | --- |
| #79 `cf10f41` | baseline (run 39689244592) | 98 s | 104 s | 77, 68 s |
| #80 `703caac` | control (run 39715678632) | 54 s | 98 s | 98, 102, 97 s |
| #81 `91934e2` | 1: shallow freeze only | 106 s | 67 s | — |
| #82 `b8faf6a` | 2: memo test removed | 49 s | 107 s | — |
| #83 `7ef0185` | 3: envelope on the #79 dust-0 unfrozen cycle | 103 s | 99 s | — |

All 10 runs passed 14/14.

- **Finding:** there is no code-level overhead.
  - Every variant, the #79 baseline included, falls in a ~50–70 s or a ~97–107 s band from run to run. The earlier
    comparison used two #79 samples that both happened to be fast.
  - Means: #79 87 s (n = 4), #80 90 s (n = 5).
- **Deep freeze:** about 0 ms locally on the 16,384-holder cycle (85,704 objects). The pipeline already freezes the
  artifact and snapshot. Kept.
- **Memo test:** it already uses a 24-holder micro-fixture (2 s locally) and never builds a 16,384-holder cycle.
  Kept.
- **Dust threshold:** dust 0 and dust 1,000 cycles cost the same. The envelope tests stay on `SHARED_16K`.
- **Likely source (unconfirmed):** the CI annotations say `ubuntu-latest` is migrating to Ubuntu 26 from October 19,
  2026, so runner images or hardware may be mixed. The job logs, which would show it, are not readable here.
- **Outcome:** no change to #80. All pinned values are intact (layout 2 leaves, RFC 9162 path lengths, read-model
  image `4c0ff458…` / 16,412,652 bytes, C# samples).
- **Clean-up:** the diagnostic PRs #81–#83 are closed. Their branches (`diag/yield-80-nofreeze`, `-nomemo`, `-dust0`)
  could not be deleted from this sandbox (git proxy HTTP 403) and can be removed on GitHub.
- **Holds unchanged:** no merges, deployments, signing, chain or network access.

## 2026-10-22, 02:45 local (shared 16,384-holder cycle across the #78 and #79 suites)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #80 | shared, memoized 16,384-holder cycle helper (tests only; `unit-shared-cycle` project dropped) | `feature/yield-shared-16k-cycle` | `703caac` | #79 | 39715678632 (attempts 2–5) | 14/14 passed |

- **Helper:** `sharedLargeCycle(params)` is memoized on `globalThis`.
  - The key covers holders, seed, profile and dust threshold. Results are deeply frozen, parameters are checked
    strictly, and failed builds are not cached.
  - Simulation-only rules are unchanged.
  - `SHARED_16K` = 16,384 holders, seed `0xe17e10e5`, extreme profile, dust threshold 1,000.
- **Config:** vitest isolates modules per file, so sharing needs both files in one non-isolated process. The new
  `unit-shared-cycle` project (one fork, `isolate: false`) does this; `test:unit` runs it with `unit`.
- **Invariants:** #79 pins unchanged. #78 has no pins at 16,384 holders (bounds only) and now uses the shared
  dust-1,000 cycle. #78's 4,096-holder pins are unchanged. The memo test proves the key includes seed and dust
  threshold.
- **Finding:** the unit job took 191 s, up from 107 s. Sharing serializes the two heavy files, which previously ran in
  parallel.
- **Owner decision: drop the project (`703caac`).**
  - `vitest.config.ts` and the scripts are restored exactly to #79, so the heavy files run in parallel workers again.
    Each builds the same frozen `SHARED_16K` cycle once. The helper, key checks, deep freeze and memo test are kept.
  - No pinned value changed, and `clients/` is untouched.
  - CI run 39715678632:
    - attempt 1: 13/14; Dependency audit failed (`pnpm audit` ran 250 s, exit 1; no dependency changed, so likely
      transient);
    - attempts 2 and 3: 14/14 passed.
  - Unit-test timings (test step / job):

    | Run | Test step | Job |
    | --- | --- | --- |
    | #79 `cf10f41`, two attempts | 77 / 68 s | 107 / 98 s |
    | #80 with the shared project | 159 s | 191 s |
    | #80 `703caac`, three attempts | 98 / 102 / 97 s | 131 / 131 / 123 s |

  - Parallelism is restored, but the job did **not** return to ~105–110 s: it stays about 25–30 s slower than #79.
    Locally the heavy files time the same as at #79 (envelope 38 s, read-model 58–59 s), and the memo test takes
    2 s. The CI-only gap is unexplained.
  - Remaining differences from #79: the memo test file, the envelope file on the frozen dust-1,000 cycle, and the
    deep freeze. Isolating the cause needs a CI bisect; the job logs are not readable from this sandbox.
- **Holds unchanged:** no production code; simulation only; no chain, network, storage, signing, deployment or merge.

## 2026-10-22, 02:30 local (claim read model: low-memory single-holder lookups)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #79 | claim read model: indexed records, image round trip, C# sample | `feature/yield-claim-read-model` | `cf10f41` | #78 | 39689244592 | 14/14 passed |

Commits: `8681fb2` (read model; tree-level helpers; claim-lookup indexing), `bde2016` (tests, C# sample), `ec01ce8` (test
fix after the first CI run), `cf10f41` (test strategy revised for CI time; tests only).

- **Interfaces:** `ClaimReadModelStore` (get) and `ClaimReadModelSink` (put; records are immutable). Only an in-memory
  store exists. A durable store would implement the same two interfaces.
- **Records:**
  - a header: published tree, cycle summary, tree level sizes;
  - holder records: claim with leaf index, withheld, or deferred with its reason;
  - unattributed holdings and a recipient index;
  - leaves (layout 2 bytes);
  - each tree node once, by level and index.
- **Queries:** opening reads the header only, pinned by the expected artifact hash. A claim costs 2 + path-length reads
  (at most about 1.5 KB at 16,384 holders), and the proof is rebuilt from stored nodes. Every claim is verified against
  the pinned tree before it is served; tampered leaves, nodes or index records give `corrupt`.
- **Persistence:** a deterministic byte image pinned by SHA-256 (4,096 holders: `79f1704f…`, 4,067,466 bytes). It
  round-trips to identical bytes. There is no file, database or network I/O.
- **Tests:** at 4,096 and 16,384 holders, every holder's result equals the in-memory lookup's, with exact read counts.
  Fail-closed checks cover projection, open, queries and images.
- **C#:** `claim-readmodel.sample.json` claims are identical to the #78 large-tree sample's. `ReadModelCrossStackTests`
  decodes every layout 2 leaf exactly and verifies every claim.
- **Also:** `createClaimLookup` now indexes plan entries once. Behaviour is unchanged; lookups had been quadratic.
- **Test strategy (`cf10f41`, owner request, tests only):**
  - 4,096 holders keep the full every-holder cross-check.
  - 16,384 holders (fixed seed, dust threshold 1,000) check instead:
    - the pinned image (`4c0ff458…`, 16,412,652 bytes) and its round trip;
    - exact hash calls: projection L leaf + (Σpath + L − 1) node, and 1 + path per served claim;
    - a stable seeded subset of 1,024 holders (`splitMix64(0x5b5e7)`, plus the first `below_dust_threshold` holder,
      which the pick missed), covering claims, withheld, `zero_amount` and `below_dust_threshold`;
    - read-count bounds;
    - tamper detection.
  - The unit job takes 107 s, down from 144 s (73 s on #78).
- **CI note:** the first run (`bde2016`, run 39686212325) failed in Unit tests. A deep `toEqual` over the ~16 MB image
  enumerates every index in vitest. Fixed by a byte loop. The unit job now takes 144 s (73 s on #78), mostly the
  all-holder check at 16,384 holders.
- **Holds unchanged:** simulation only; no chain, network, storage, signing, deployment or merge.

## 2026-10-22, 02:00 local (large-holder performance and memory envelopes)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #78 | deterministic envelope tests, large-tree C# sample (tests only) | `feature/yield-large-holder-envelope` | `db3bbe0` | #77 | 39683144164 | 14/14 passed |

- **Deterministic envelopes:** cost is counted in hash calls (a counting hasher), not timed.
  - Tree build makes exactly L leaf and L − 1 node hashes at 4,096 and 16,384 holders.
  - The pipeline makes exactly 2L leaf and (L − 1) + Σpath node hashes.
  - Opening the lookup costs exactly L + Σpath hashes, and each claim verifies with exactly 1 + path-length hashes.
  - Proof lengths match RFC 9162 exactly.
  - The artifact is pinned for a seeded 4,096-holder cycle (SHA-256 `3e374c9b…`, 7,487,231 bytes), stable on rerun and
    after a JSON round trip.
- **Caps only (stable in CI):** < 120 s and < 1 GiB heap growth per build; 16,384-holder artifact ≤ 2,560 bytes per holder
  and < 64 MiB; 512 lookups verified in < 60 s. The unit-test job time did not grow (73 s).
- **Cross-stack:** `claim-payloads.large-tree.sample.json` (43 claims with proofs up to 12 deep, 21 `zero_amount`
  deferrals), verified in C# (`LargeTreeCrossStackTests`) and by an independent Python RFC 9162 verifier.
- **Holds unchanged:** no production code changed; simulation only; no chain, network, storage, signing, deployment or
  merge.

## 2026-10-22, 01:30 local (zero-allocation policy: option B)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #77 | zero-allocation policy, TS and C# | `feature/yield-zero-allocation` | `ba3b7f0` | #76 | 39680962950 | 14/14 passed |

- **Decision (owner asked for one): option B.** A payable entry is never 0. A party whose amount is 0 is `deferred` with
  `deferredReason: "zero_amount"`, whatever the dust threshold.
  - The rule is fixed, not configurable: no wallet → withheld; amount 0 → deferred `zero_amount` (takes precedence);
    below the threshold → deferred `below_dust_threshold`; otherwise payable.
  - Why B rather than A: it keeps `dustThreshold: 0n` valid instead of pre-empting D-9. It also holds for any threshold
    and is enforced at every layer. On leaves and roots it is equivalent to A: threshold 0 and 1 give the same root on
    1,200 extreme holders.
  - A zero amount carries nothing forward, so conservation is unchanged. Non-zero amounts keep their previous states.
- **Where it is enforced:**
  - the planner (`partyEntryState`);
  - the pipeline's `calculate` and `cycleArtifactProblems` (`distribution_invalid`);
  - the leaf encoder and decoder in TS and C#, so proof and payload verification reject a zero leaf in both stacks;
  - the claim lookup, which reports the deferral reason to holders.
- **Cross-stack:** new `Samples/claim-payloads.tiny-holders.sample.json` (31 claims, 13 `zero_amount` deferrals). C#
  recomputes the allocation and states with `BigInteger` and requires an exact match, and an independent Python check
  agrees. In the regenerated `claim-payloads.sample.json`, the root and claims are unchanged; only the artifact hash and
  one lookup reason changed.
- **Holds unchanged:** simulation only; no chain, network, signing, deployment or merge.

## 2026-10-22, 01:00 local (ownership ingestion interface; 1,000+ holder stress harness)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #76 | ownership ingestion interface, simulation adapters, synthetic generator, scale tests | `feature/yield-ownership-ingestion` | `670d624` | #75 | 39678157321 | 14/14 passed |

- **Interface:** `IOwnershipSourceAdapter` returns a `VerifiedOwnershipSnapshot`. `loadVerifiedOwnershipSnapshot` is the entry
  point and fails closed:
  - real-network requests are refused before the adapter is called;
  - only `simulationOnly: true` adapters are accepted;
  - the result must re-verify, be frozen, and answer the request (asset, network, reference, verification time).
- **Adapters:**
  - `MockOwnershipAdapter`: deterministic synthetic data.
  - `FileFixtureOwnershipAdapter`: a strict JSON fixture with decimal-string u64s, read through an injected reader, with an
    optional SHA-256 pin. The domain reads no files.
  - A chain-backed adapter (Y0/Y5) is still blocked on D-16, D-12 and D-17.
- **Generator:** SplitMix64 over bigints, canonical order by construction, uniform, skewed and extreme u64 profiles. The
  committed 40-holder fixture is reproduced byte for byte by an independent Python implementation.
- **Scale:** the pipeline with layout 2 leaves over 1,024, 1,537, 1,200 (extreme: total > 100 × u64), 2,048 and 4,096
  holders. Each run is checked independently: every proof, every leaf, the root via the twin implementation, exact
  largest-remainder allocation, conservation, and determinism by seed. No stack or size limits were hit.
- **Finding (no behaviour change):** with the simulation default `dustThreshold: 0n` (pending D-9), a zero allocation is a
  payable entry, and the claim tree refuses the whole cycle (fail closed). Real datasets with tiny holders need a threshold
  of at least 1, or a D-9 rule deferring zero allocations.
- **Holds unchanged:** no chain, RPC, network, signing, deployment or merge.

## 2026-10-22, 00:27 local (owner decision: leaf layout 2 approved)

The owner approved claim leaf layout 2 in these terms:

- Layout 2 binds claims to a verified ownership snapshot without breaking layout 1.
- It is byte-identical to layout 1 for the first 201 bytes and appends a 32-byte SHA-256 `snapshot_hash`: 233 bytes.
- Layout 1 stays supported; its existing parity vectors stay authoritative.
- The pipeline and new artifacts may require layout 2; verification fails closed on layout confusion or a snapshot
  mismatch.
- Snapshot normalisation refuses non-canonical (unsorted) input; it does not re-sort silently.

This records the decision only; the plan document is not changed. The code on #75 already met every point. The
owner's "byte-identical" holds in every byte except offset 195, the layout version itself (1 or 2), which is the byte
that keeps the layouts apart. One test was added to pin these rules in TypeScript as well as C#: `64187cd` on #75
(`claim-tree.test.ts`, "keeps layouts 1 and 2 apart"). The yield tests touched by #75 pass locally (claim tree 17,
snapshot 14, pipeline 21, lookup 6). CI on `64187cd`: 14/14 checks passed, including lint.

Where each point is enforced:

| Point | TypeScript | C# |
| --- | --- | --- |
| 201-byte prefix + 32-byte hash | `encodeClaimLeaf`, `claim-tree.test.ts` | `ClaimLeafCodec`, `TheCodecKeepsLayoutsApart` |
| Layout 1 vectors authoritative | `claim-tree.vectors.test.ts` (unchanged) | `ClaimTreeParityTests` |
| Pipeline requires layout 2 | `pipeline.ts` (`ownership_unbound`) | — |
| Fail closed on confusion or mismatch | `decodeClaimLeaf`, `verifyClaimPayload` | `ClaimLeafCodec.Decode`, `ClaimPayloadVerification` |
| No silent re-sort | `ownership-snapshot.ts` (`not_canonical_order`) | — |

## 2026-10-21, night (ownership snapshot verifier; leaf layout 2)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #75 | ownership snapshot verifier, bound into the pipeline and every leaf | `feature/yield-ownership-snapshot` | `b7854a7` | #74 | 39664489877 | 14/14 passed; C# 82 passed (81 on #74) |

- **Snapshot verifier:** `verifyAndNormalizeSnapshot` takes raw u64 shares as bigints and returns a deeply frozen
  `VerifiedOwnershipSnapshot`, with exact integer share bases and a SHA-256 commitment (matches an independent Python
  vector).
  - Network ids: simulation only; real networks are refused.
  - Parties: unique and already in canonical order; unsorted input is refused.
  - Payout addresses: unique after normalisation.
  - Total: an exact bigint sum, refused if zero.
  - This verifies a snapshot as data. Reading ownership from a chain (Y0, Y5) is still not built.
- **Pipeline binding:** the pipeline consumes the verified snapshot.
  - It requires the snapshot's asset to match the leaves' asset and builds **leaf layout 2**: the §6.2 leaf plus the
    32-byte snapshot hash, 233 bytes.
  - The artifact embeds the snapshot; verification recomputes its hash, requires it in every leaf, and requires the
    plan's shares and addresses to match it.
  - A one-unit share change or an address change fails verification, even with the snapshot and artifact hashes
    recomputed.
- **Needs owner acknowledgement (approved 2026-10-22, see above):** leaf layout 2 is an addition to the plan's §6.2 table, which defines layout 1
  only. The plan document is not changed. Layout 1 and its parity vectors are untouched.
- **C#:** the codec handles layout 2; the payload verifier requires the trusted snapshot hash inside the leaf.
- **Holds unchanged:** no signing, chain or network access.

## 2026-10-21, late night (simulation cycle pipeline; claim lookup; C# cross-stack check)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #72 | pipeline base (#71 + #68, merge only) | `feature/yield-pipeline-base` | `d337374` | #71 | 39647092532 | 14/14 passed |
| #73 | simulation cycle pipeline | `feature/yield-cycle-pipeline` | `3abb337` | #72 | 39647564986 | 14/14 passed; C# 77 passed |
| #74 | claim lookup and C# cross-stack verification | `feature/yield-claim-lookup` | `6c944de` | #73 | 39648432879 | 14/14 passed; C# 81 passed (+4 cross-stack tests) |

- **Pipeline (#73), simulation only:**
  - `calculate` (`inputs_locked` → `calculated`) goes from committed evidence (Y4), through aggregation with recorded
    FX and the waterfall, to the distribution plan, the claim tree and a verified, frozen artifact.
  - `calculate` is refused if any proof fails `verifyClaimLeafProof` or conservation breaks.
  - `submit` (`calculated` → `under_review`) re-verifies the artifact (hash, every proof, conservation).
  - The plan's state machine has no "committed" state: the artifact set is frozen at `calculate` (§2.2). No state was
    added to Y1.
  - **Conservation:** claim leaves + dust carried + withheld + unattributed + carried remainder = inflow (the net
    distributable amount plus anything carried in).
- **Claim lookup (#74):**
  - A read-only lookup over a verified simulation artifact, by party id or payout address.
  - It returns the `metafarm-yield-claim/1` payload, or the reason there is no leaf (deferred, withheld,
    unattributed, not in cycle).
  - `verifyClaimPayload` binds the trusted published tree and the cycle id and version inside the leaf.
- **Cross-stack check (#74):**
  - `clients/unity-starter/Samples/claim-payloads.sample.json` is generated from #73's live multi-party pipeline run;
    a vitest test fails if the committed file differs.
  - The C# client deserializes it with its own settings and runs `VerifyClaimLeafProof` and
    `ClaimPayloadVerification` on every claim.
- **Still caller-supplied:** ownership snapshots (Y0 and Y5 not built). No signing, chain or network access.

## 2026-10-21, late night (C# claim-leaf and proof parity)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #71 | C# claim leaf codec and proof verifier, TS-generated vectors | `feature/yield-claim-csharp` | `d8df413` | #70 | 39645297546 | 14/14 passed; C# tests 77 passed, 0 failed (65 on #70; +12 parity tests) |

- **C# (`clients/unity-starter/Runtime/Core/Yield`):**
  - Built as netstandard2.1 with C# 9 and warnings as errors; verification only.
  - `ClaimLeafCodec` encodes and decodes the plan's §6.2 201-byte leaf exactly as `claim-tree.ts` does. UUIDs use
    RFC 4122 byte order, not `System.Guid`'s.
  - `ClaimTreeVerifier` covers leaf hashes, RFC 9162 roots and proofs, and `VerifyClaimLeafProof`, which binds the
    trusted root, size and leaf index.
- **Vectors:** `clients/unity-starter/Samples/claim-tree-vectors.json` is generated from TypeScript
  (`claim-tree.vectors.test-support.ts`).
  - Trees of 1, 3, 5, 7 and 8 leaves (24 proofs), plus an edge leaf with every integer field at its maximum.
  - A vitest test fails if the committed file differs from what TypeScript produces.
  - The vectors were checked once with an independent Python implementation.
  - How to regenerate: see the starter README ("Claim-tree vectors").
- **Not run locally:** the C# could not be built in the sandbox (the .NET download is blocked); CI is the first and
  only C# run.
- **Simulation only** (D-26 open). No signing, chain or network access.

## 2026-10-21, night (Y4 evidence storage model; pluggable claim tree)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #68 | Y4: evidence storage model, append-only ledger | `feature/yield-evidence-store` | `bd505e9` | #67 | 39638781162 | 14/14 passed |
| #69 | claim-tree base (#67 + #64, merge only) | `feature/yield-claim-base` | `fa5bf3e` | #67 | 39638855433 | 14/14 passed |
| #70 | claim tree: leaves, root, proofs, pluggable hashing | `feature/yield-claim-tree` | `f20da4b` | #69 | 39639488074 | 14/14 passed |

- **Y4 (#68):**
  - A deeply frozen, append-only evidence ledger. Committing a cycle version records the Y3 manifest hash and
    closes that version to further evidence.
  - Corrections are superseding items, with forks refused.
  - Evidence bytes go through the #41 content-store port and are checked by size and SHA-256 both ways.
  - `assertEvidenceLedger` re-verifies a loaded ledger.
  - **D-24 fail-closed:** registration needs a storage policy record, and the default is simulation-only
    (in-memory). No public storage option is offered.
  - **Gate recorded:** Y4's approval to begin also lists a [Legal] data-protection review, needed before any
    real adapter or real evidence.
- **Claim tree (#70):**
  - The plan's §6.2 leaves (201 bytes) from #64's payable entries, one leaf per payout wallet,
    0 < amount ≤ u64.
  - An RFC 9162 tree over a pluggable hasher, whose default is the plan's SHA-256 construction.
  - **Checks:** leaf bytes, leaf hash and example F's root match an independent Python vector; the tree matches
    `twin/commitments` for every size from 1 to 40.
  - `verifyClaimLeafProof` binds the trusted root and size, and the index inside the leaf, because an RFC 9162
    path alone does not bind the tree size.
  - **D-26 fail-closed:** the policy names the hasher, and the default is a simulation record.
  - **Inputs left to the caller:** the cluster identity (Y0, not built) and the network id (a registry constant
    not yet defined).
  - **Not done:** C# parity (Y6).
- **Holds unchanged:** no merges, deployments, signing or chain access.

## 2026-10-21, evening (three parallel tracks; provisional defaults are simulation-only)

| PR | Track | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #64 | 1: distribution plan engine | `feature/yield-distribution-engine` | `e508e3c` | #61 | 39632610018 | 13/13 passed |
| #65 | 3: attester authorization (Option B, provisional) | `feature/yield-attester-registry` | `853689e` | #63 | 39632995539 | 14/14 passed |
| #66 | Y2 + Y3 integration (merge only) | `feature/yield-y2y3-base` | `977bbb0` | #63 | 39633087016 | 14/14 passed |
| #67 | 2: evidence aggregation, reserve-offset ceiling | `feature/yield-evidence-aggregation` | `cfa667d` | #66 | 39633473853 | 14/14 passed |

- **Owner direction:** pending decisions become parameters with temporary defaults.
- **How the defaults are held:**
  - Every pending parameter is a required field, marked with its decision: D-7, D-9, D-14, D-23.
  - Defaults ship as `simulation`-status records.
  - Real cycles still need `approved` records and fail closed.
- **Track 1 naming:** it is not the plan's Y4, which is evidence-storage wiring. It is the pre-Merkle distribution engine; D-26 is open.
- **Track 2's offset:** the reserve offset of a loss (D-7), as an estimate only.
- **Track 3:** Option B is implemented behind a swappable `AttesterAuthorizer` interface. D-23 stays open.
- **Holds unchanged:** no merges, deployments, signing or chain access.

## 2026-10-21, 19:29 local (D-23 decision brief; no approvals)

- **Added** [`decision-brief-d23-attester-identity.md`](decision-brief-d23-attester-identity.md), marked
  OPEN — FOR REVIEW ONLY (NO APPROVALS). It covers:
  - the gap: attester identity is not bound to the signing key;
  - the threat model;
  - options A–D, with their analysis;
  - the artifacts needed from L, S, P and T;
  - non-goals and blocked scope;
  - ten next questions.
- **Unchanged:** no code, tests, migrations, plan document, deployment settings or holds were touched.
  The PR heads are as in the entry below.
- **Next action:** owner and approver review of the brief. D-23 stays open.

## 2026-10-21, late evening (test hardening; two defects fixed)

### Current heads (all drafts, none merged)

| PR | Branch | Head | CI run | Checks |
| --- | --- | --- | --- | --- |
| #60 Y1 | `feature/yield-y1-cycle-model` | `2bbc68e` | 39610916939 | 13/13 passed |
| #61 Y2 | `feature/yield-y2-calculation` | `e90142b` | 39625909640 | 13/13 passed |
| #62 yield stack base | `feature/yield-stack-base` | `e709cf8` | 39619248296 | 14/14 passed |
| #63 Y3 | `feature/yield-y3-evidence` | `4d08b9a` | 39625783828 | 14/14 passed |

- **#61:** `e90142b` supersedes `04e7cc6`, which superseded `6f3dd20`.
- **#62:** for a while the API reported the Dependency audit job as `in_progress` after the run had
  completed. Its final record shows success (14:43:27Z → 14:43:56Z), so the earlier status was stale
  and #62 is 14/14.
- Y1 did not change, so no stack merges were needed.

### Defects found by the hardening

- **Security (Y3, `821b507`).** Web Crypto (OpenSSL) accepts Ed25519 signatures under small-order public
  keys. With the identity point as the key, `R = identity, S = 0` verifies for every message, so a
  key-signature attestation could be made without any secret. Small-order keys (libsodium's list, either
  sign bit) and non-canonical keys (y ≥ p) are now refused. The regression tests fail without the fix.
- **Calendar (Y3 `81ff91a`, Y2 `e90142b`).** `Date.UTC` maps years 0–99 to 1900–1999, so `0000-02-29` was
  refused. Days per month are now computed directly. Mutation-checked on Y2.

### Tests added

- **Y3:**
  - quorum: all 4,368 graphs of up to 3 roles × 3 attesters, checked against a brute-force oracle in
    both modes, with independence from input and rule order; a 40-role augmenting chain; a Hall
    violation; a 60 × 60 assignment;
  - evidence: a Unicode manifest vector computed in Python; lone surrogates; NFC/NFD; type/hash
    collisions; byte order over 200 items × 25 permutations; RFC 3339 boundaries;
  - attestation: Ed25519 and P-256 negative vectors, and domain-separation injectivity.
  - Counts: evidence 19, attestation 28, quorum 6, quorum properties 6.
- **Y2:** about 3,000 seeded conversion cases up to `U64_MAX` and exponent 30, plus timestamp boundaries.
  fx now has 10 tests; Y2 has 48 in total.

### Recorded behaviour (pinned by tests, not decided)

- Identifiers are compared by code units, with no Unicode normalisation.
- Lowercase `t` and `z` in timestamps are refused.
- Both ECDSA S forms are accepted.
- Conversion results are not bounded to u64 (allocations are).

### Open (D-23)

A valid key signature proves only that the key holder signed. It does not bind the attester's identity
to an approved key, so one party could create several keys under different attester names. This is
part of the attester identity requirements.

### Blockers and holds

Unchanged from the entry below.

## 2026-10-21, evening (Y1–Y3 implemented; batch complete)

### Stack (all drafts, none merged)

```
main ← #60 Y1 ← #61 Y2
#59 ← #62 yield stack base (#59 + Y1, merge commit, no code) ← #63 Y3
```

Stacked PRs are kept current by merging the parent into the child, never by rebasing (owner decision).

| PR | Branch | Head | CI run | Checks |
| --- | --- | --- | --- | --- |
| #60 Y1: cycle model, record usability, gates | `feature/yield-y1-cycle-model` | `2bbc68e` | 39610916939 | 13/13 passed |
| #61 Y2: calculation library | `feature/yield-y2-calculation` | `04e7cc6` | 39619194031 | 13/13 passed |
| #62 yield stack base | `feature/yield-stack-base` | `e709cf8` | 39619248296 | 13 of 14 passed; the Dependency audit job stayed `in_progress` after the run reported success (a GitHub reporting fault). The package manifests are identical to #63's head, whose audit passed |
| #63 Y3: evidence and attestation model | `feature/yield-y3-evidence` | `6bd2ad4` | 39619589979 | 14/14 passed (13 plus Unity starter core, C#) |

Earlier validated heads, for reference: #60 `2bbc68e` (run 39610916939, 13/13); #61 `6f3dd20`
(run 39610918668, 13/13), superseded by `04e7cc6` (one fix, below).

### Completed

- **Y1 (#60):** states, commands and transition table of §2.1; future phases always refused; a
  simulation cycle can never be funded; four-eyes refuses identical, blank, padded or non-string
  identities; record usability (real cycles: `approved` only; simulation cycles: `simulation` only;
  `draft`: neither); fail-closed gate requirements per step, each named with its decision. D-14 is
  reported as a requirement only.
- **Y2 (#61):** waterfall with fee alternatives F1–F4, rational FX, rounding down with recorded dropped
  fractions, proportional split with explicit remainder rule and dust marking, u64 bound, canonical
  calculation artifact that recomputes its own numbers. No exported economic defaults; unsupported keys
  refused. Plan examples A–G are `simulation` fixtures.
- **Y3 (#63):**
  - evidence items (no defaults; retention class by id) and the `metafarm-yield-evidence/1` manifest,
    sorted by (type, contentSha256), with an independently computed hash vector;
  - attestations with the three methods of §5.4; Ed25519 and ECDSA P-256 signatures **verified, never
    produced**; domain-separated signed message; acceptance only under a method list usable by the
    cycle (D-23 fail-closed);
  - quorum as data (§12.1): distinct attesters per role; whether one attester may fill several roles is
    a required record field; maximum matching, so the result never depends on input order.
  - Signature tests use published RFC 8032 and RFC 6979 vectors only. Nothing creates a key or a
    signature, so there is no end-to-end positive key-signature acceptance test.

### Fixes found during this batch

- Y1 `9cd8088`, `2bbc68e`: a lint fix; `approve` is a reviewer's command (plan §2.1); four-eyes hardened.
- Y2 `a12a8ba`, `6f3dd20`: unsupported keys refused; the artifact recomputes its result and conversion;
  expense lines in canonical order.
- Y2 `04e7cc6`: rate times must be real calendar instants (`Date.parse` rolls 2026-02-30 forward to
  2026-03-02). Found while building Y3, which has the same check.
- Y3 `be1c168`: a type-only import (CI Lint on `fd7a93d`; that run was then cancelled by the next push).

### Verification

- Local: a vitest-compatible harness (the npm registry is not reachable from the build sandbox), and
  `tsc` strict over the yield files. The only local `tsc` errors are in `harvest.ts` and `tasks.ts`,
  because `zod` is not installed in the sandbox.
- CI is the authority for lint, the repository's type-check, vitest, build, Playwright and images.

### Blocked, and why (plan §11.1)

| PR | Blocked by |
| --- | --- |
| Y0 | D-16 (cluster identifier, storage, binding) must be approved to build |
| Y4 | owner authorisation **and** a [Legal] data-protection review (approval to begin) |
| Y5 | Y0; D-12 (slots or elapsed time) and D-17 to build |
| Y6 | D-26 (claim-tree hash function) to build |
| Y7 | D-31 and D-17 to build; Y0–Y6 |
| Y8 | D-28 to build; Y7 |
| Y9 | D-11 confirmation to build; Y8 |
| Y10–Y14 | Y8, Y9 or Y12 (and D-29 for Y12) |
| Y15–Y17 | separate devnet, program or production approvals; the deploy hold |

Outside the yield plan, the #40–#59 stack waits on Unity 6 validation, live-chain checks and the
deploy holds (`readiness.md`).

### Holds (unchanged)

No merges to `main`; no deployments or Railway changes (worker hold, #45; staged patch `f14b940d`
untouched); no signing, secrets, mainnet, TRON or RWA execution.

### Next action

Owner decisions on group 1 of the decision-gate matrix (§12.2: D-16, D-17, D-26, D-28, D-31, D-11,
D-12) would unblock Y0 and Y5–Y9. Y4 needs the data-protection review.
