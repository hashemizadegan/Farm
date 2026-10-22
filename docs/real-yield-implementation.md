# Real-yield distribution: what this branch line implements, and what is gated

> **Line join (2026-10-22, Option A):** the integration branch `integration/yield-ownership-join` is the
> ownership-index line (#95) with the yield line (#84) merged in. On it, the Y9 workflow's engine is the yield
> domain's simulation pipeline (`apps/api/src/lib/yield-pipeline-engine.ts`) fed by a per-cycle **simulation
> dossier** (`packages/domain/src/yield/simulation-dossier.ts`, migration 0026). See "After the join" below.

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

## After the join

- **Engine:** `createPipelineYieldEngine()` runs `calculateSimulationCycle`: the Y2 waterfall over a Y4 evidence
  ledger, the #75 snapshot, the #77 distribution plan and the #70 claim tree with snapshot-bound leaves.
  - It is pure and deterministic.
  - It is wired in `apps/api/src/main.ts` and is used only by the Y9 workflow, which stays off by default and
    refused in production.
- **Dossier:** the typed simulation records the tables do not hold.
  - Contents:
    - the calculation and distribution policies (status `simulation`);
    - the settlement rate and the distribution ledger;
    - full evidence-item metadata;
    - one line per locked input;
    - simulation payout addresses;
    - the snapshot observation time.
  - It is registered while the cycle is a draft, stored content-addressed and append-only (0026), and is
    simulation cycles only.
  - The engine checks it against the locked cycle: policy hash, entitlement, currency, formula, settlement, every
    line and every evidence hash. Any difference is `dossier_mismatch`.
- **Fail closed:**
  - `simulation_only`;
  - `dossier_missing`, `dossier_incomplete`;
  - `real_network_ownership`: ownership from a verified RPC source is a real network. The yield-line snapshot accepts
    simulation networks only, and devnet use needs the Y15 approval. This guard is kept, not relaxed;
  - `weight_exceeds_u64`: slot weights beyond the #75 u64 shares;
  - `carry_from_dossier_refused` and `carry_mismatch`: carry-in comes only from the predecessor's recorded carry-out
    (0028), by hash;
  - `calculation_refused`: any pipeline refusal, with its own code in the message.
- **Stored rows:**
  - set hash = the whole cycle artifact's SHA-256;
  - calculation, allocation and evidence hashes = the pipeline's;
  - root = the claim-tree root, or the RFC 9162 empty-tree hash when nothing is payable;
  - rows = payable → `allocated`, `withheld`, `unattributed`; deferred dust plus the carried remainder in one `dust`
    row that carries the deferred parties' weight.
- **Simulation leaf context:** network id 0, a zero cluster identity, epoch 0. Real values come with Y6 final
  (D-26 [Ext]) and Y0 live use.
- **Persisted at calculate (G2, 0027):**
  - the frozen artifact as canonical text, its hash checked by the database and equal to the set hash;
  - every claim leaf with its proof (root = the set root; amount = the party's allocated row).
  - `calculate` cannot complete without them. Reads come from storage only, and are re-verified:
    - operators: `GET …/artifact-sets/{setId}/leaves`;
    - holders, through an active link, behind the holder switches: `GET …/me/yield/cycles/{cycleId}/proof`.
- **Carry-forward (G3, 0028):**
  - each calculation records its carry-in and carry-out (canonical, hashed);
  - the predecessor is fixed by one rule (`yield_carry_source`): the latest published or closed simulation cycle of
    the same asset ending earlier;
  - the carry-in must be its carry-out; open intermediate cycles block; real cycles are refused.
- **Network label (R1, security review 2026-10-22):** every cycle the workflow creates is a simulation, and its
  `network` label must be `solana-devnet`. `solana-mainnet` is refused with 409 `simulation_network_label`, checked
  with the request body before authentication and before any query (`SIMULATION_CYCLE_NETWORKS` in
  `apps/api/src/routes/yield.ts`). The database domain (0024) still lists both labels for the day real cycles are
  approved; until then, no simulation cycle can claim to concern mainnet assets.
- **Shapes:** `docs/delivery/yield-adapter-shapes.md` (G1).
- **Still not built:**
  - unsigned claim intents (D-15, D-25, D-27, D-39);
  - the final leaf context and hasher (Y6 final, D-26 [Ext]);
  - economic reconciliation (Y14) beyond the record checks.

## Local preview of the operator pages (`/yield`)

**D-39:** the simulation banner wording was adopted by the owner on 2026-10-22. Every `/yield` view starts with it,
verbatim (`apps/web/src/app/yield/layout.tsx`, `components/yield/YieldSimulationDisclosure.tsx`, the constant
`D39_SIMULATION_DISCLOSURE`):

> SIMULATION ONLY: Yield metrics, cycles, and claim intents displayed in this interface are generated from
> deterministic simulation models. No real assets, mainnet signatures, or monetary liabilities are incurred.

The adoption covers the simulation operator views only. The staging and production refusals are unchanged.

**Run it locally** (needs Docker for PostGIS, Redis and MinIO, and Node with pnpm):

```sh
cp .env.example .env            # APP_ENV=development, DEV_AUTH_SECRET set
docker compose up -d            # PostGIS, Redis, MinIO
pnpm install
pnpm db:migrate && pnpm db:seed # demo workspace and the dev users
pnpm seed:yield                 # three simulation cycles (idempotent)
pnpm dev:yield                  # API :4000, worker, web :3000, with the yield switches on for this run only
pnpm --filter @metafarm/api dev-token dev-user   # paste the token at http://localhost:3000/sign-in
```

**Pages:**

- `http://localhost:3000/yield` lists the cycles: Q1 and Q2 2026 *Published, with verification details*, and Q3
  2026 *Awaiting independent review*. Each carries the *Simulation* badge.
- `http://localhost:3000/yield/<cycleId>` shows one cycle:
  - the D-39 banner;
  - status, chain asset and slot range;
  - **Four-eyes approval:** prepared by, attestations, approved by, and whether preparer ≠ approver;
  - **Calculation dossier:** revision and hash, the simulation policies, settlement rate and lines;
  - **Artifact sets:** status (*Frozen*, *Approved*, *Invalidated*), hashes, ownership snapshot provenance, and
    carry-in/carry-out;
  - **History.**
- On published cycles, **Claim intents (unsigned)**: the batch built from stored leaves (set number, batch hash,
  *Unsigned*, *simulation*), with one row per leaf (party, amount, payout address, leaf hash, proof steps).

**Seeded scenario** (`apps/api/src/scripts/seed-yield-simulation.ts`):
- holders A (with a payout address), B (none: withheld), D (tiny: deferred dust, carried forward) and an unregistered
  wallet;
- preparer `dev-yield-preparer`, auditor `dev-yield-auditor`, approver `dev-user`.

The same stack runs in CI: the Playwright job (`tests/e2e/yield-operator.spec.ts`) seeds, walks these pages, fails on
any console or page error, and uploads screenshots as the `yield-screenshots` artifact.
