# Yield security review package (2026-10-22)

**This is not a sign-off. Nothing in this document is approved.** It was prepared by the implementing agent as
input for an independent reviewer (plan revision 4, `f914af4`, §11.2). A box is ticked only by the named approver,
with a date and a reference to their written record.

## Executive summary (one page)

**What is asked.** Security sign-offs that would allow the simulation-only yield line to run in an **isolated
preview**:
- Y0, Y5, Y7 and Y12;
- migrations 0019–0029 (§A), of which 0026–0029 are the newest.

Nothing here asks for production use. Production approval is a separate decision, listed in §C as **not granted**.

**What the code does.** It computes yield for **simulation** cycles only:
- inputs, evidence and ownership are simulation-labelled;
- the result is frozen as a content-addressed artifact with a Merkle claim tree;
- a four-eyes review publishes it;
- **unsigned** claim intents can then be built from the stored leaves.

Nothing signs, submits, pays, contacts a mainnet, or uses TRON. Real cycles are stopped by the database at
`inputs_locked` (`yield_cycles_real_gate`).

**Why it is low-risk to preview.**
- Every new table has forced row-level security and is append-only for the application (no UPDATE or DELETE
  grants, except the guarded `yield_cycles` and `party_account_links` updates and the idempotency store).
- Every stored document is checked by a SHA-256 CHECK.
- The lifecycle and four-eyes rules are enforced by triggers.
- All yield switches are off by default and refused in staging/production by configuration.
- The seed refuses anything but development or test.
- A preview is reachable only through the private-preview access gate (#98).

**Known residual risks** (detail in §1–§5):
- the migration owner role can disable triggers (operational: review the owner's rights);
- large document limits (availability only);
- R1, the `solana-mainnet` cycle label, is **fixed in draft #100**;
- consent is a request, not a signature (Y12);
- a provider can misreport its genesis hash (Y0, F4).

**State of the code.**
- Draft PRs only.
- Integration #96 at `565aaee`; preview branch #99, with #100 (R1) and #101 (seed runner) on top.
- CI green on every head listed in §D.
- Production (`melodious-liberation`) is untouched: `main` at `b59eaff`, database at 0018.

## Sign-off register (all unticked)

Approver: an independent security reviewer named by the owner. The implementing agent may not tick any box.

| ☐ | Item | Scope of review | Material | Approver / date / record |
|---|---|---|---|---|
| ☐ | **Y0** verified cluster identity (#85) | `packages/chain/src/solana/cluster.ts`, `packages/db/src/repositories/ownership-index.ts`, worker ownership-index handler, migration 0023 | §1, `y0-security-review.md` | |
| ☐ | **Y5** holdings and provenance (#86) | `packages/db/src/repositories/weighted-ownership.ts`, `packages/domain/src/yield/ownership-*.ts` | §1, `y5-y7-y12-security-notes.md` | |
| ☐ | **Y7** yield schema core (#87) | migration 0024, `packages/db/src/repositories/yield.ts` | §1, §A.0024 | |
| ☐ | **Y12** account-to-party links (#92) | migration 0025, `apps/api/src/routes/party-links.ts`, `holder-yield.ts` | §1, §A.0025 | |
| ☐ | Migration **0019** twin foundation (#40) | §A.0019 | §A | |
| ☐ | Migration **0020** ownership index (#50) | §A.0020 | §A | |
| ☐ | Migration **0021** idempotency (#54) | §A.0021 | §A | |
| ☐ | Migration **0022** player wallets (#57) | §A.0022 | §A | |
| ☐ | Migration **0023** ownership source identities (#85, Y0) | §A.0023 | §A, `y0-security-review.md` | |
| ☐ | Migration **0024** yield core (#87, Y7) | §A.0024 | §A | |
| ☐ | Migration **0025** party account links (#92, Y12) | §A.0025 | §A | |
| ☐ | Migration **0026** simulation dossiers (#96) | §A.0026 | §2, §A | |
| ☐ | Migration **0027** frozen artifacts and claim leaves (#96) | §A.0027 | §2, §A | |
| ☐ | Migration **0028** carry ledgers (#96) | §A.0028 | §2, §A | |
| ☐ | Migration **0029** claim-intent batches (#96) | §A.0029 | §2, §A | |
| ☐ | **R1 fix** (#100) | `apps/api/src/routes/yield.ts`, tests | §5 | |
| ☐ | **Preview access gate** (#98) | `apps/api/src/plugins/preview-gate.ts`, `apps/web/src/lib/preview-gate.ts`, `apps/web/src/middleware.ts` | `docs/preview-access-gate.md` | |
| ☐ | **Seed runner** for the preview (#101) | `apps/api/src/scripts/*`, `Dockerfile` target `seed-runner` | `yield-preview-architecture-proposal.md` | |
| ☐ | **Preview-use approval** of branch `preview/yield-simulation` (§B) | Everything above | §B | |

Statuses used below:
- `READY FOR REVIEW`: the material is complete and nothing is known to be missing.
- `BLOCKED — SECURITY SIGN-OFF REQUIRED`: cannot be used outside local development and CI until signed off.
- `VERIFIED IN SIMULATION ONLY`: behaviour checked by automated tests on simulation data only.
- `NOT APPLICABLE`.

**Code reviewed:**
- the integration branch `integration/yield-ownership-join` at `565aaee` (draft PR #96);
- the ownership line #85–#95 below it;
- the preview branch #99 and its add-ons #100 and #101.

Earlier detailed reviews, referenced and not repeated:
- `y0-security-review.md`;
- `y5-y7-y12-security-notes.md`;
- the D-12, D-16, D-17 and D-23 decision briefs.

## Production state (unchanged)

- The Railway project `melodious-liberation` (environment `production`) runs `main` at `b59eaff`, with
  `APP_ENV=staging` on the API.
- Its database has migrations **through 0018 only**. **Nothing in this package has been applied to it.**
- Migrations 0019–0029 exist only on unmerged draft branches.
- None of the yield switches is set there. They are refused in staging/production anyway:
  - `YIELD_CLAIM_INTENTS_ENABLED`, `HOLDER_YIELD_ENABLED` and the web's `NEXT_PUBLIC_YIELD_PAGES_ENABLED`:
    refused in staging and production;
  - `YIELD_WORKFLOW_ENABLED` and `PARTY_LINKS_ENABLED`: refused in production.
- The worker deploy hold (#45) is in place.

## Summary

| Item | Status | Approval required |
|---|---|---|
| Y0 verified cluster identity (#85, migration 0023) | BLOCKED — SECURITY SIGN-OFF REQUIRED | Security sign-off (S); deploy hold lifted; full-history node choice |
| Y5 holdings and provenance (#86) | BLOCKED — SECURITY SIGN-OFF REQUIRED | Security sign-off (S) |
| Y7 yield schema core (#87, migration 0024) | BLOCKED — SECURITY SIGN-OFF REQUIRED | Security sign-off (S); review of the migration owner role in deployment |
| Y12 account-to-party links (#92, migration 0025) | BLOCKED — SECURITY SIGN-OFF REQUIRED | Security sign-off (S); consent text (legal, D-29) |
| Migration 0026 simulation dossiers | BLOCKED — SECURITY SIGN-OFF REQUIRED | Migration sign-off |
| Migration 0027 frozen artifacts and claim leaves | BLOCKED — SECURITY SIGN-OFF REQUIRED | Migration sign-off |
| Migration 0028 carry ledgers | BLOCKED — SECURITY SIGN-OFF REQUIRED | Migration sign-off |
| Migration 0029 claim-intent batches | BLOCKED — SECURITY SIGN-OFF REQUIRED | Migration sign-off |
| Dossier integrity | VERIFIED IN SIMULATION ONLY | Covered by the 0026 sign-off |
| Frozen artifacts | VERIFIED IN SIMULATION ONLY | Covered by the 0027 sign-off |
| Carry-forward persistence | VERIFIED IN SIMULATION ONLY | Covered by the 0028 sign-off |
| Unsigned simulation claim intents (Y13) | VERIFIED IN SIMULATION ONLY | 0029 sign-off; any real use needs D-15, D-25, D-26, D-27 and D-30 |
| Four-eyes approval model | VERIFIED IN SIMULATION ONLY | Covered by the Y7 sign-off |
| Environment guards | READY FOR REVIEW | Reviewer confirmation |
| Seed restrictions (`seed:yield`) | READY FOR REVIEW | Reviewer confirmation |
| D-39 disclosure banner | READY FOR REVIEW | Wording adopted 2026-10-22. A disclosure *version approval* for deployed use is still open. |
| Paths to signing, TRON, mainnet, holder-facing behaviour | READY FOR REVIEW | Reviewer confirmation of the analysis in §5 |
| R1 fix: no mainnet label on simulation cycles (#100) | READY FOR REVIEW | Register row |
| Preview seed runner (#101) | READY FOR REVIEW | Register row; needed for any preview data |
| Private-preview access gate (#98) | READY FOR REVIEW | Needed before any preview deployment |
| Real distribution (payouts, signing, holder claims) | NOT APPLICABLE | Not built. Real gates D-15, D-25, D-26, D-27, D-30 and Unity 6 validation are open. |

## 1. Ownership foundation

### Y0: verified cluster identity (#85, `20ccaae`; migration 0023)
- **Purpose:**
  - RPC-sourced ownership rows are bound to a verified Solana cluster identity (genesis hash, scheme, host);
  - unverified rows are never served.
- **Files:**
  - `packages/chain/src/solana/cluster.ts`;
  - `packages/db/src/repositories/ownership-index.ts`;
  - `apps/worker/src/handlers/ownership-index.ts`;
  - `apps/worker/src/main.ts`;
  - `0023_ownership_source_identities.{up,down}.sql`.
- **Data written:**
  - `ownership_source_identities`, written by the system role only;
  - the identity binding on ownership events and cursors.
- **Roles:**
  - `metafarm_app` has SELECT only on identities (insert and update refused: 42501);
  - writes run as the system role.
- **Fail mode:** closed.
  - Any cluster error, a changed identity or another network writes nothing and doesn't move the cursor.
  - An RPC source without a guard is refused (`identity_not_configured`).
  - `TWIN_OWNERSHIP_INDEX_ENABLED` is off by default.
- **Rollback:**
  - the down migration drops what 0023 created;
  - the `NOT VALID` checks need unbound pre-0023 rows cleared before `VALIDATE` (F6).
- **Tests:**
  - Y0 unit and integration tests;
  - 28 constraint cases on PostgreSQL 16;
  - the F1 reproduction (see `y0-security-review.md`).
- **Residual risks:**
  - a provider can lie about its genesis hash (F4: detects misconfiguration, not malice);
  - each batch is verified twice, so latency is possible (F7);
  - the application role can read provider host names (F8).
- **Approval required:** security sign-off (S). Also needed before live use: the deploy hold lifted, J7 enabled by
  the owner, and a full-history node chosen.

### Y5: holdings and provenance (#86)
- **Purpose:** time-weighted holdings over a slot window from the ownership index, with strict provenance.
  - Verified RPC rows win.
  - Fixture rows are kept but never served beside RPC rows.
  - Ambiguous provenance is refused (D-17, owner decision).
- **Files:**
  - `packages/db/src/repositories/weighted-ownership.ts`;
  - `packages/domain/src/yield/ownership-*.ts`;
  - `apps/api/src/line-join-provenance.test.ts`.
- **Data:** read-only (a read-only transaction as `metafarm_app`).
- **Fail mode:** closed. Mixed or ambiguous sources are refused, and so are fixture batches over a verified RPC
  cursor (twice: worker and cursor upsert).
- **Tests:**
  - `ownership-source`, `ownership-snapshot` and `ownership-scale` unit tests;
  - `twin-ownership-index.int.test.ts`;
  - `line-join-provenance.test.ts`.
- **Residual risks:**
  - provenance relies on the cursor's `source` column;
  - a database superuser can edit rows (outside the application threat model).
- **Approval required:** security sign-off (S).

### Y7: yield schema core (#87; migration 0024)
- **Purpose:** cycles, inputs, evidence, ownership snapshots, artifact sets, attestations and the transition log,
  with the state machine enforced in the database.
- **Data:** eight tables.
  - Forced RLS on all of them.
  - No DELETE grant.
  - UPDATE only on `yield_cycles`, through a guard trigger.
  - The transition log and set status are written by `SECURITY DEFINER` triggers with a pinned `search_path`.
- **Fail mode:** closed.
  - `yield_cycles_real_gate`: a non-simulation cycle cannot pass `inputs_locked`.
  - Evidence must be simulation-labelled (`yield_evidence_simulation_only`) until D-24.
  - Fixture ownership is refused in non-simulation cycles (D-17).
  - Amounts are limited to u64 by CHECK.
- **Rollback:** the down migration drops 0024's objects. There is no data to preserve outside simulation.
- **Tests:**
  - `yield-schema.test.ts` and `yield-schema.int.test.ts`;
  - `yield-workflow.int.test.ts`;
  - the domain `cycle` and `gates` tests.
- **Residual risks:**
  - the migration owner can disable triggers, so review that role's rights in the deployment;
  - `status_reason` is free text and must be treated as personal data under the retention policy.
- **Approval required:** security sign-off (S).

### Y12: account-to-party links (#92; migration 0025)
- **Purpose:** proposed → consented → active → revoked links between workspace members and parties, the basis
  for any holder view.
- **Roles:** the authoriser must be neither the proposer nor the member. One live link per party and per member.
- **Fail mode:** closed.
  - Behind `PARTY_LINKS_ENABLED`: off by default, refused in production.
  - The consent text is flagged `approved: false`.
- **Tests:** `party-links.int.test.ts` and `holder-yield.int.test.ts`.
- **Residual risks:**
  - consent is a signed-in request, not a cryptographic signature;
  - member onboarding is out of scope.
- **Approval required:** security sign-off (S). The consent text needs legal review (D-29). Holder-facing use
  needs D-39 version approval.

## 2. Migrations 0026–0029 (append-only records of the simulation pipeline)

All four share the same pattern:
- `tenant_id` foreign key with `ON DELETE RESTRICT`;
- forced RLS, with tenant isolation for `metafarm_app` and an owner bypass for the migration role;
- `GRANT SELECT, INSERT` only, so no UPDATE and no DELETE;
- an `append_only()` trigger refusing UPDATE and DELETE even for the owner path;
- a SHA-256 content-hash CHECK on every stored document;
- a BEFORE INSERT guard trigger with stable `yield:*` hints;
- a **simulation-only** gate (`yield:real_gate` or `yield:simulation_record_in_real_cycle`);
- each down migration drops only what its up migration created.

None of them can hold data for a non-simulation cycle.

| Migration | Tables | Guard conditions (all on insert) | Rollback note |
|---|---|---|---|
| 0026 `yield_simulation_dossiers` | 1 | The cycle is simulation and in `draft`. Body ≤ 4 MB. Unique `(cycle_id, revision)`. | Drop table and function. Dossiers are inputs, recomputable. |
| 0027 `yield_frozen_artifacts`, `yield_claim_leaves` | 2 | Simulation cycle; set and cycle in `calculated`. The artifact hash must equal the set's hash. Each leaf's root is the set's root, the tree size equals the artifact's leaf count, and each leaf pays exactly its party's allocated amount. Leaf amount 0 < a ≤ u64. Unique per set by index, recipient and party. Plus a `yield_cycles` trigger: **calculate cannot complete without the frozen artifact and all its leaves**. | Drops the `yield_cycles` trigger too. Rolling back after cycles are calculated removes the evidence that they were frozen, so roll back only an empty or simulation-only database. |
| 0028 `yield_carry_ledgers` | 1 | Simulation cycle in `calculated`. The source is exactly the predecessor set, and the carry-in byte-equals the predecessor's carry-out. Carry is consumed in order (an earlier open cycle refuses it). Genesis has an empty ledger. Plus a `yield_cycles` trigger: **calculate needs the set's carry record**. | As 0027. Also drops `yield_carry_source(uuid)` (granted EXECUTE to `metafarm_app`). |
| 0029 `yield_claim_intent_batches` | 1 | Simulation cycle in `published` with its approved set. The batch names its cycle and set and is an **unsigned simulation** batch. The intent count equals the stored leaves. One batch per set. | Drop table and function. Batches are rebuildable byte for byte from the stored leaves. |

Each row has the same fields:
- **Data:** canonical JSON text plus hashes. No secrets, keys or signatures.
- **Roles:** writes come from API routes needing `yield:prepare` (dossier, calculate) or `yield:approve`
  (intents). Reads need `yield:read`.
- **Tests:**
  - `yield-pipeline.int.test.ts` and `yield-read.int.test.ts` (PostgreSQL with PostGIS in CI);
  - `yield-pipeline-engine.test.ts` and `yield-engine.test.ts`;
  - the domain `artifact`, `claim-tree` (with published vectors), `claim-intent`, `multi-cycle` and
    `distribution` tests.

**Residual risks:**
- A large body limit (200 MB) is allowed for artifacts and batches, which is an availability risk only.
  Consider lower limits before any shared deployment.
- The owner bypass policy means the migration role sees all tenants (as in earlier migrations).

**Approval required:** an explicit security sign-off per migration (0026, 0027, 0028, 0029) before any
non-local database receives them.

## 3. Simulation pipeline features

- **Dossier integrity (Y6 join, 0026):**
  - the engine checks the dossier against the database: policy hash, entitlement, currency, settlement, every
    line and every evidence hash;
  - any difference refuses the calculation;
  - every record inside must be simulation-labelled (`not_simulation`);
  - parsing is strict (exact keys, no defaults);
  - the dossier read endpoint re-hashes before returning.
- **Frozen artifacts (0027):**
  - calculate persists the artifact and leaves in the same transaction as the state change;
  - later reads (proofs, intents, carry) use stored data, never recomputation;
  - the database refuses partial persistence.
- **Carry-forward (0028):**
  - the carry-in is read from the persisted predecessor's carry-out, never supplied by the caller;
  - order and identity are enforced by the database.
- **Claim intents (Y13, 0029):**
  - data only: `signed: false` and `simulation: true` are fixed in the type and checked by the database;
  - built only from stored leaves after verifying each proof;
  - deterministic (`createdAt` is the artifact's time);
  - refused for non-simulation networks (`non_simulation_network`; allowed: `simulation`, `solana-localnet`),
    while payouts are paused, or when the artifact is missing or mismatched;
  - behind `YIELD_CLAIM_INTENTS_ENABLED`, refused in staging and production;
  - no signing code exists in the module.
- **Four-eyes:**
  - the approver may be neither the creator nor the preparer (database trigger);
  - attestation needs `yield:attest` (owner or verifier); approval needs `yield:approve` (owner or admin);
  - the operator page shows prepared by, attested by, approved by and whether the roles are separated
    (`fourEyes()`, unit-tested).
- **Operator pages (Y10):**
  - read-only, staff only (`yield:read`);
  - the build is refused in staging and production while `NEXT_PUBLIC_YIELD_PAGES_ENABLED` is set;
  - the D-39 banner is on every `/yield` view;
  - Playwright `yield-operator.spec.ts` verifies the banner, states, four-eyes, dossier, carry and intents, with
    no console or hydration errors.

## 4. Environment guards, seed, disclosure

- **Guards (`packages/config/src/index.ts`, `apps/web/next.config.ts`):**
  - `AppEnvironment` is development | test | staging | production; no other value is accepted;
  - in staging/production, dev auth and `DEV_AUTH_SECRET` are refused, and so are memory storage, mock
    imagery and wildcard CORS;
  - the yield switches are refused as listed above;
  - none is weakened by any PR in this line or by #97 and #98.
- **Seed (`apps/api/src/scripts/seed-yield-simulation.ts`):**
  - refused unless `APP_ENV` is development or test, checked before any connection;
  - needs `DEV_AUTH_SECRET`;
  - runs the real routes in-process, so every trigger applies;
  - idempotent;
  - simulation-labelled data only;
  - the fixture ownership uses a random devnet-labelled asset id with no chain contact.
- **D-39:**
  - `D39_SIMULATION_DISCLOSURE` in `apps/web/src/lib/yield.ts`, id `D-39/simulation-banner/2026-10-22`;
  - English-only in all locales (`lang="en" dir="ltr"`);
  - the wording is unchanged by this package.

## 5. Paths to signing, TRON, mainnet or holder-facing behaviour

The yield modules were searched for signer, keypair, transaction, TRON and mainnet references, and each reachable
path was traced:
- **Signing.** No yield module imports or calls a signer. Intents carry `signed: false` by type, and the 0029
  guard refuses anything else.
- **TRON.** No yield code references TRON. The RWA worker's TRON settings are separate and unchanged.
- **Mainnet:**
  - ownership from a verified RPC source is refused by the engine (`real_network_ownership`; devnet needs the
    Y15 approval);
  - intents require a simulation network id;
  - the RWA `RWA_MAINNET_ENABLED` switch is untouched.
- **Holder-facing:**
  - holder routes need `HOLDER_YIELD_ENABLED` and `PARTY_LINKS_ENABLED`, both refused in staging/production;
  - the operator pages are staff-only.
- **Finding R1 (Low), fix in draft #100:** cycle creation accepted `network: "solana-mainnet"` as a label of the
  chain asset. The workflow forces `simulation: true`, so such a cycle was simulation-only and nothing was
  contacted or signed, but the label could mislead a reader.
  - **Fix (option A, reject at validation time):** `POST …/yield/cycles` now refuses any label outside
    `SIMULATION_CYCLE_NETWORKS = ["solana-devnet"]` with **409 `simulation_network_label`**. The check runs with the
    body, before authentication and before any query (`apps/api/src/routes/yield.ts`).
  - The schema and the 0024 database domain are unchanged, so real cycles can use the label once approved.
    There is no new migration.
  - **Tests:** `apps/api/src/yield-network-label.test.ts` (unit, no database) and an assertion in
    `apps/api/src/yield-workflow.int.test.ts` that nothing is written.
  - **Docs:** the OpenAPI description and `docs/real-yield-implementation.md`.
  - **Status:** READY FOR REVIEW (register row "R1 fix").

## 6. Pending approvals (none is recorded as given)

1. Security sign-off (S): Y0, Y5, Y7, Y12.
2. Security sign-off per migration: 0026, 0027, 0028, 0029. Migrations 0019–0025 also need review before they
   reach a non-local database: they are part of the same unmerged line.
3. Approval to deploy the integration branch to an **isolated** preview. See
   `yield-preview-architecture-proposal.md`.
4. A D-39 disclosure version approval before any deployed (non-local) display.
5. Real-use gates, all open and out of scope: D-15, D-25, D-26, D-27, D-30, Unity 6 validation, devnet
   approval (Y15).

## A. Migration reference (0019–0029)

Common to every tenant-scoped table below, unless stated:
- `tenant_id` foreign key;
- `ENABLE` + `FORCE ROW LEVEL SECURITY`;
- policy `tenant_isolation` for `metafarm_app` (`tenant_id = app_current_tenant()`);
- policy `owner_bypass` for the migration owner.

"System role" means the owner connection used by workers and `withSystem`. "App" means `metafarm_app`.

The first three tables (0019–0022, 0023–0025, 0026–0029) are compact listings. Each is followed by a
"Data flows and rollback" table for the same migrations.

### 0019–0022: platform prerequisites from the frozen #40–#59 stack (not yield-specific)

| | **0019** twin foundation (#40) | **0020** ownership index (#50) | **0021** idempotency (#54) | **0022** player wallets (#57) |
|---|---|---|---|---|
| Tables | `data_commitments`, `commitment_batches`, `commitment_batch_leaves`. Alters `business_assets_kind_check` (+ building, storage_unit, logistics_lot) | `chain_ownership_events`, `chain_ownership_cursors` (public chain data, not tenant-scoped, no RLS) | `idempotency_records` | `player_wallets`, `player_wallet_challenges` (per user, not per tenant) |
| Indexes | `data_commitments_subject_idx`, unique `data_commitments_request_idx` (partial), `commitment_batches_dataset_idx`, unique `commitment_batches_request_idx` (partial) | Unique `chain_ownership_events_identity_idx`, `chain_ownership_events_asset_idx` | `idempotency_records_expiry` | `player_wallets_user_idx`, `player_wallet_challenges_user_idx` |
| Triggers / functions | None | None | None | None |
| Roles | App: SELECT, INSERT (append-only, no UPDATE or DELETE) | App: SELECT only. Writes by the system role (indexer) | App: SELECT, INSERT, UPDATE, DELETE (expiring cache of responses) | **No grant to app.** Read only for the signed-in user through system queries |

### 0023–0025: ownership identity, yield core, party links

| | **0023** ownership source identities (#85, Y0) | **0024** yield core (#87, Y7) | **0025** party account links (#92, Y12) |
|---|---|---|---|
| Tables | `ownership_source_identities`. Adds `source_identity_id` to events and cursors, with composite FK and identity CHECKs (`NOT VALID`) | `yield_cycles`, `yield_cycle_transitions`, `yield_evidence`, `yield_inputs`, `yield_ownership_snapshots`, `yield_artifact_sets`, `yield_allocations`, `yield_attestations` | `party_account_links`, `party_account_link_events` |
| Indexes | `chain_ownership_events_source_identity_idx` | `yield_cycles_asset_idx`, `yield_cycles_status_idx`, `yield_cycle_transitions_cycle_idx`, `yield_inputs_cycle_idx`, `yield_inputs_source_idx`, `yield_ownership_snapshots_cycle_idx`, `yield_ownership_snapshots_identity_idx`, unique `yield_artifact_sets_live_idx`, `yield_allocations_cycle_idx`, unique `yield_allocations_{holder,party,dust}_idx`, `yield_attestations_set_idx` | `party_account_links_user_idx`, unique `party_account_links_{party,user}_live_idx` |
| Triggers / functions | None (constraints only) | Guards on cycles, inputs, snapshots, artifact sets (insert and update), allocations and attestations; `yield_cycles_created`; `yield_cycle_command`; append-only on transitions, evidence, inputs, snapshots, allocations and attestations. `yield_cycles_guard` and `yield_cycles_created` are **SECURITY DEFINER**, with pinned `search_path` and `EXECUTE` revoked from PUBLIC | `party_account_links_guard`, `party_account_links_proposed` (**SECURITY DEFINER**, pinned `search_path`, revoked from PUBLIC); append-only on events |
| Roles | App: SELECT. Writes by the system role (the worker) | App: SELECT, INSERT on all except transitions; UPDATE on `yield_cycles` only (through the guard); SELECT only on `yield_cycle_transitions` (trigger-written) | App: SELECT, INSERT, UPDATE on links (guarded steps); SELECT on events (trigger-written) |

### 0026–0029: simulation pipeline records

| | **0026** simulation dossiers | **0027** frozen artifacts and claim leaves | **0028** carry ledgers | **0029** claim-intent batches |
|---|---|---|---|---|
| Tables | `yield_simulation_dossiers` | `yield_frozen_artifacts`, `yield_claim_leaves` | `yield_carry_ledgers` | `yield_claim_intent_batches` |
| Indexes | Unique `(cycle_id, revision)`; `yield_simulation_dossiers_cycle_idx` | Unique `(artifact_set_id)`; `yield_frozen_artifacts_cycle_idx`; leaves unique by set and index, set and recipient, set and party; `yield_claim_leaves_set_idx` | Unique `(artifact_set_id)`; `yield_carry_ledgers_cycle_idx`, `yield_carry_ledgers_source_idx` | Unique `(artifact_set_id)` and `(cycle_id, set_number, batch_sha256)`; `yield_claim_intent_batches_cycle_idx` |
| Triggers / functions | `yield_simulation_dossiers_guard` (simulation cycle in draft); append-only | `yield_frozen_artifacts_guard` (on both tables); append-only on both; **`yield_cycles_require_frozen_artifact`** on `yield_cycles` | `yield_carry_ledgers_guard`; append-only; `yield_carry_source(uuid)`; **`yield_cycles_require_zcarry`** on `yield_cycles` (named to run after the 0027 trigger) | `yield_claim_intent_batches_guard`; append-only |
| Roles | App: SELECT, INSERT (+ sequence) | App: SELECT, INSERT (+ sequences) | App: SELECT, INSERT (+ sequence); EXECUTE on `yield_carry_source` | App: SELECT, INSERT (+ sequence) |

### Data flows and rollback (0019–0022)

| | Data flow | Rollback (down migration) |
|---|---|---|
| **0019** | API writes content-hash commitments and batches; nothing reads them back into calculations | **Refuses** to revert while any commitment, batch or new-kind asset exists |
| **0020** | Worker (J7, off by default) → events and cursors; the reader rebuilds holdings | Drops both tables. The index is derived and can be rebuilt from the chain |
| **0021** | The API stores the first response per key and replays it | Drops the table. Only cached responses are lost |
| **0022** | The user signs an off-chain challenge (no transaction) and the API records the wallet | Drops both tables. Links are lost; users re-link |

### Data flows and rollback (0023–0025)

| | Data flow | Rollback (down migration) |
|---|---|---|
| **0023** | Worker verifies the cluster, registers the identity, then binds the rows in one transaction | Drops the constraints, columns and table. Unbound RPC rows become indistinguishable again: rebuild the index |
| **0024** | Operator routes: draft → lock → calculate → submit → attest → approve → publish. The database enforces each step; real cycles stop at `inputs_locked` | Drops every 0024 object. Simulation data only; there is no real data to preserve |
| **0025** | Propose → consent (member) → authorise (third person) → revoke | Drops both tables. Links are lost, and with them holder access |

### Data flows and rollback (0026–0029)

| | Data flow | Rollback (down migration) |
|---|---|---|
| **0026** | The preparer registers a dossier while the cycle is draft; `calculate` reads the latest revision; a read route re-hashes it | Drops the table and function. Dossiers are inputs and can be registered again |
| **0027** | `calculate` writes the artifact and all leaves in its transaction; proofs, intents and review read them | Drops the triggers, tables and function. **Only on a database holding simulation data:** it removes the frozen record of calculated cycles |
| **0028** | `calculate` writes `ledger_in` (= the predecessor's `ledger_out`) and `ledger_out` | Same caution as 0027 |
| **0029** | `POST /claim-intents` (`yield:approve`) builds the batch from the stored leaves of a published cycle | Drops the table and function. Batches are rebuildable byte for byte |

The migrator (`packages/db/src/migrate.ts`) applies every pending `.up.sql` in sorted order and refuses a migration
modified after being applied (checksum). A database that receives 0026 therefore also receives 0019–0025.

## B. Preview-only approval (what ticking the register would permit)

If, and only if, every box in the register is ticked, the approval permits:
- deploying branch `preview/yield-simulation` (#99, plus #100 and #101) to a **new, separate Railway project**, as
  described in `yield-preview-architecture-proposal.md`;
- running migrations 0019–0029 on that project's **new** database only;
- `APP_ENV=development` there, with dev auth;
- `YIELD_WORKFLOW_ENABLED`, `YIELD_CLAIM_INTENTS_ENABLED` and `NEXT_PUBLIC_YIELD_PAGES_ENABLED` set to `true`;
- `PREVIEW_ACCESS_GATE` **on** for api and web;
- running the demo seed and `seed:yield` there through the seed runner (#101);
- staff-only viewing of `/yield`, with the D-39 banner.

It does **not** permit:
- any change to `melodious-liberation`, or a merge of anything to `main`;
- applying any of 0019–0029 to the production database;
- `PARTY_LINKS_ENABLED` or `HOLDER_YIELD_ENABLED`, or any holder-facing view;
- any signer, RPC, DAS or TRON variable; `RWA_MAINNET_ENABLED`; `TWIN_OWNERSHIP_INDEX_ENABLED`;
- real (non-simulation) cycles, payouts, claims, or signed or submitted intents;
- a preview without the access gate, or a gated preview reachable with a shared password published anywhere;
- lifting the worker deploy hold (#45). The preview runs no worker.

## C. Production approval: **NOT GRANTED**

No production approval exists or is requested here. Production use needs, at minimum:
- everything in §B;
- the real gates D-15, D-25, D-26, D-27 and D-30;
- D-24 (retention); D-29 (consent text, legal);
- D-39 disclosure version approval for deployed display;
- Unity 6 validation; devnet approval (Y15);
- the full-history node choice (Y0);
- a resolution of #45;
- a reviewed merge plan for the #40–#99 stack into `main`.

Until then, every yield switch stays refused in staging and production by configuration, and nothing in this
package changes that.

## D. Verification heads (CI)

| PR | Head | CI |
|---|---|---|
| #96 integration | `565aaee` | 14/14 |
| #97 lockfile | `6205425` | 13/13 |
| #98 access gate | `b9b831b` | 13/13 |
| #99 preview branch | `1c9024e` | 14/14 |
| #100 R1 | `d0d2876` | 14/14 |
| #101 seed runner | `b642ec7` | 15/15 (adds the `seed-runner` image and its smoke step; the earlier head `43e7a76` failed integration on a guard defect, fixed in `b642ec7`) |

## E. Ready-for-sign-off checklist (reviewer procedure)

Work through it in order. Record findings against the register rows; tick a register box only when every step
for that row is done and nothing is open.

**0. Set up**
- [ ] Check out `preview/yield-simulation` (#99). Merge #100 and #101 locally, or review them as separate diffs.
- [ ] Confirm each CI head in §D is green. Note any newer head and re-check it.
- [ ] Confirm production is untouched: `main` at `b59eaff`; the live database at 0018, from the API log
  `[migrate] already up to date` on `b59eaff`; no merge of this line pending.

**1. Migrations 0019–0029 (one register row each)**
- [ ] Read each up and down file against §A: tables, indexes, triggers, functions, grants and policies match. Find
  any object not listed.
- [ ] Every tenant-scoped table: `ENABLE` and `FORCE ROW LEVEL SECURITY`, `tenant_isolation` for
  `metafarm_app`, no grant broader than §A.
- [ ] Every `SECURITY DEFINER` function (0024: 2; 0025: 2) pins `search_path` and revokes `EXECUTE` from PUBLIC.
- [ ] Every append-only table has the `append_only()` trigger, and the app has no UPDATE or DELETE grant on it.
- [ ] Every simulation gate (0024 `yield_cycles_real_gate`; 0026–0029 guards) refuses non-simulation cycles.
  Use the integration tests `yield-schema.int.test.ts`, `yield-pipeline.int.test.ts` and `yield-read.int.test.ts`
  as evidence, or run them against PostgreSQL 16 with PostGIS.
- [ ] Run up → down → up on an empty database. Confirm the 0019 down refusal with data, and the 0027 and 0028
  rollback caution.
- [ ] Review the migration owner's rights in the intended deployment: it can disable triggers.

**2. Y0, Y5, Y7, Y12**
- [ ] Y0: re-read `y0-security-review.md` F1–F8 and confirm F1, F3 (fixed) and F2 (D-17, fixed in #86).
- [ ] Y5: the provenance rules in `y5-y7-y12-security-notes.md`, with `line-join-provenance.test.ts`.
- [ ] Y7: the state machine and four-eyes in 0024. The approver can be neither creator nor preparer: try it in
  `yield-workflow.int.test.ts`.
- [ ] Y12: the steps, uniqueness and immutability in 0025. The switch is refused in production
  (`packages/config/src/index.ts`).

**3. No path to signing, TRON, mainnet or holders (§5)**
- [ ] Search the yield modules (domain `yield/`, API `routes/yield.ts`, `lib/yield-*`, the db repository, web
  `/yield`) for signer, keypair, transaction, TRON and mainnet. Every hit is a refusal or a label.
- [ ] R1 (#100): `solana-mainnet` gets 409 `simulation_network_label` before any query
  (`yield-network-label.test.ts`).
- [ ] Intents: `signed: false` in the type and checked by the 0029 guard; only simulation network ids.

**4. Guards, seed, disclosure**
- [ ] `packages/config/src/index.ts`: yield, party-link and holder switches refused as stated in §4; dev auth
  refused in staging and production; no `preview` value in `AppEnvironment`.
- [ ] `apps/web/next.config.ts`: `NEXT_PUBLIC_YIELD_PAGES_ENABLED` refused in staging and production builds.
- [ ] `seed-yield-simulation.ts` refuses anything but development or test before connecting.
- [ ] The seed runner (#101) refuses non-allow-listed `APP_ENV` before connecting, refuses databases with other workspaces or
  real (non-`dev`) sign-ins, and under-migrated databases (`preview-seed-guard.test.ts`, `preview-seed-runner.int.test.ts`, CI smoke step), and
  production images are unchanged (Dockerfile targets; `tsup` entries).
- [ ] D-39: `D39_SIMULATION_DISCLOSURE` matches the adopted wording and is English-only on every `/yield` view
  (`yield-operator.spec.ts`).

**5. Access gate (#98)**
- [ ] API: only `/healthz`, `/readyz` and `OPTIONS` pass unauthenticated; invalid switch values refuse to start
  (`preview-gate.test.ts`).
- [ ] Web: every path including assets; constant-time compare; 503 without a password; no `NEXT_PUBLIC_`
  exposure (`preview-gate.test.ts`, `middleware.test.ts`).
- [ ] Off by default; production behaviour unchanged (Playwright green with the gate off).

**6. Decide**
- [ ] Tick register rows individually, with name, date and record.
- [ ] If every row is ticked: the **preview-only** approval of §B can be recorded.
- [ ] §C (production) stays **not granted** regardless.
