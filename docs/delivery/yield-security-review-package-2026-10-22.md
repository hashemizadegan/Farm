# Yield security review package (2026-10-22)

**Purpose.** Material for the pending security sign-offs on the yield line (plan revision 4, `f914af4`, §11.2):
Y0, Y5, Y7, Y12 and migrations 0026–0029. It also covers the simulation-only features built on them (frozen
artifacts, carry-forward, dossiers, claim intents, four-eyes, the operator pages and the seed).

**This is not a sign-off.** Nothing here is approved. It was prepared by the implementing agent and needs an
independent reviewer (plan §11.2). Statuses:
- `READY FOR REVIEW`: the material is complete and nothing is known to be missing.
- `BLOCKED — SECURITY SIGN-OFF REQUIRED`: cannot be used outside local development and CI until signed off.
- `VERIFIED IN SIMULATION ONLY`: behaviour checked by automated tests on simulation data only.
- `NOT APPLICABLE`.

**Code reviewed:**
- the integration branch `integration/yield-ownership-join` at `565aaee` (draft PR #96, CI 14/14 including
  Playwright);
- the ownership line #85–#95 below it.

Earlier detailed reviews, which this package references and does not repeat:
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
- **Finding R1 (Low):** cycle creation accepts `network: "solana-mainnet"` as a label of the chain asset
  (`createCycleSchema`). The workflow forces `simulation: true`, so such a cycle stays simulation-only. Fixture
  ownership can be indexed under that label, and the pipeline's artifact network is `simulation`, so nothing is
  contacted or signed. The label can still mislead a reader. **Proposed:** restrict the enum to
  `solana-devnet` until a real gate is approved. Not changed here; for the reviewer to decide.

## 6. Pending approvals (none is recorded as given)

1. Security sign-off (S): Y0, Y5, Y7, Y12.
2. Security sign-off per migration: 0026, 0027, 0028, 0029. Migrations 0019–0025 also need review before they
   reach a non-local database: they are part of the same unmerged line.
3. Approval to deploy the integration branch to an **isolated** preview. See
   `yield-preview-architecture-proposal.md`.
4. A D-39 disclosure version approval before any deployed (non-local) display.
5. Real-use gates, all open and out of scope: D-15, D-25, D-26, D-27, D-30, Unity 6 validation, devnet
   approval (Y15).
