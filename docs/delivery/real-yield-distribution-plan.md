# Real yield distribution layer: plan

**Status: proposal for review, revision 4. Nothing here is approved, implemented, migrated or
deployed.** This plan authorises no implementation, execution, deployment, signing or chain
connection. Every recommendation is provisional until the owner approves it, and nothing here is a
legal conclusion.

**Inspected:**
- `main` at `b59eaff`;
- the top of the draft stack, `feature/retire-evm-wallet-link` at `ebb3f56` (PR #59, which contains
  #40–#59).

Revision 2 corrected the issues raised in the repository review of revision 1 (`485a6e0`). Revision 3
(from `6f28a3f`) aligns decision timing with the first operation that needs each decision (§11, §12),
separates safeguards from open policies (§0.3), adds the disclosure-governance decision D-39, and
qualifies statements flagged in the decision briefing (§13). Revision 4 (from `a80fc90`) applies the
revision-3 review: consistent gates for D-3, D-11, D-13, D-14, D-17, D-18 and D-24, a read-only Y15,
the D-19 coverage gap, and the open questions in §13.2.

**Labels used throughout:**

| Label | Meaning |
| --- | --- |
| **[Repo]** | Confirmed in the repository at the commits above. The file is cited, with lines where useful. |
| **[Ext]** | External technical assumption. Must be verified before it is relied on. |
| **[Product]** | Product proposal, pending owner approval. |
| **[Legal]** | Legal or compliance proposal. Needs qualified counsel. |

A PR number marks the *open draft PR* that first introduced something. "main" marks code already
merged.

## 0. Foundations

### 0.1 Legal source of entitlement (governing principle)

**The platform's calculation engine does not create any holder's legal entitlement.**

- The authoritative sources of entitlement are:
  - the executed token terms;
  - the offering documents;
  - subscription agreements;
  - asset agreements (leases, service contracts, custody agreements);
  - applicable law.

  These are the **entitlement instruments**. [Legal]
- Calculation policies (§3) and formula versions must **implement and reference** the approved
  entitlement instrument. They never extend or replace it.
- If a calculation policy conflicts with the governing legal documents, **the legal documents take
  precedence**, and the cycle **must not be published** until the conflict is resolved and a
  corrected policy is approved.
- **Every yield cycle records:**
  - the entitlement instrument that applies, by identifier and version;
  - the instrument's immutable content hash (SHA-256 of the executed document);
  - the policy and formula versions that implement it.

  Publication is blocked when any of these is missing.
- **A legal entitlement review is required before implementation for each supported asset class**
  (decision D-1). That means before any asset-class-specific support is built, and before any
  non-simulation cycle of that class can `lock`. Asset-class-neutral libraries (§11) may be built
  while D-1 is open; they create no entitlement.

### 0.2 What exists today, and what this plan builds on

The backend is **Fastify 5** with **plain SQL migrations** (`packages/db/migrations/NNNN_*.up.sql`),
PostgreSQL row-level security (`withTenant`/`withSystem`, role `metafarm_app`), typed repository
functions, zod schemas and OpenAPI 3.1. There is no ORM. TimescaleDB is optional: migration 0017
uses a continuous aggregate when the extension exists, and a plain view otherwise, according to its
own comments. [Repo]

| Building block | Where | Use in this plan |
| --- | --- | --- |
| Money as integer base units, `numeric(78,0)` | `rwa_orders.settlement_amount` (0012), `settlement_intents.amount` (0011), main | Internal accounting width for settlement amounts. Claim leaves use a narrower width (§6.2). [Repo] |
| Per-investor **`distribution` order**: money only; first leg a `distribution` settlement; no second leg | `packages/domain/src/rwa/orders.ts` lines 3 and 48, main | A possible future **push** payout rail (§6.4), under the RWA and TRON holds. [Repo] |
| Four-eyes approval of distributions and redemptions | API: `apps/api/src/routes/rwa.ts` lines 355–366 (approver ≠ creator). DB: `rwa_orders_four_eyes` (0015); `settlement_intents` CHECK `approved_by IS DISTINCT FROM requested_by` (0011). main | Every yield approval (§2). [Repo] |
| Compliance gate, checked **three times**: when an order is placed (`gate()`, `rwa.ts` lines 143–148, 422 `compliance_blocked`), when it's approved (`rwa.ts` line 366), and again before execution (`apps/worker/src/rwa/engine.ts` line 630: "KYC or screenings may have changed since the order") | `packages/domain/src/rwa/compliance.ts`, main | The same three-point pattern for any yield payout or claim (§4.4). [Repo] |
| RWA parties and `party_wallets`, unique per (tenant, network, address) | 0012, main | The **only** identity that can receive yield. [Repo] |
| Reconciliation cases (`open`/`investigating`/`resolved`/`written_off`), keyed by an order's `reconciliation_id` | 0011 and 0012, main | Payout-level cases, if payouts become distribution orders. [Repo] |
| `append_only()` trigger function | defined in `0011_rwa_rails.up.sql` line 214; used e.g. on `chain_operation_transitions` (0011) and `compliance_screenings` (0012 line 60), main | Yield fact tables (§7). [Repo] |
| `audit_events`, append-only via its own trigger (`audit_events_append_only`) | `0001_init.up.sql` lines 431–446, main | Candidate audit store (D-31). [Repo] |
| Operation lifecycle; `outcomeUnknown` | `packages/domain/src/rwa/lifecycle.ts` line 69, main | Rule for payouts whose outcome is unknown. [Repo] |
| Input and service costs: `cost numeric(15,2)` and `currency`, **both nullable** | 0005 (inventory), 0007 (`service_records`), main | Candidate cost *sources*, subject to completeness checks (§3.7). [Repo] |
| Harvest batches with a canonical public record and `record_hash` | 0004, main | Evidence of crop volume. [Repo] |
| Equipment registry and `meter_readings` (user-recorded hours per date) | 0007, main | See §2.3: not yet sufficient evidence of revenue. [Repo] |
| `canonicalJson` | `packages/domain/src/harvest.ts` line 91, main | Canonical artifacts (§3.8). [Repo] |
| Web `/rwa` page, read-only | PR #39, **merged on main** | Pattern for the yield pages. [Repo] |
| Data commitments; RFC 9162 Merkle (`metafarm-merkle-sha256/1`); `contentHash`, `merkleLeaf`, `verifyMerkleInclusion` | `packages/domain/src/twin/commitments.ts`, migration 0019: **first in PR #40** | Evidence hashing; the claim-tree hash construction. [Repo] |
| C# `Rfc9162CommitmentVerifier` (engine-free) | `clients/unity-starter/Runtime/Core/Verification`: **first in PR #40** | Proof checks in Unity (§8). [Repo] |
| Content-store interface | `packages/domain/src/twin/content-store.ts`: **first in PR #41** | Evidence store interface. [Repo] |
| Unsigned intents with a TTL | `packages/domain/src/twin/intents.ts`: **first in PR #41** | Shape of unsigned claim intents. [Repo] |
| Plan-only anchors (`executable: false`) | `packages/domain/src/twin/anchor.ts`: **first in PR #41** (its API endpoints in #43) | Planning to anchor yield roots, without anchoring. [Repo] |
| `@metafarm/storage` (object-storage implementation) | `packages/storage`: **first in PR #43** | The evidence bytes (§5.3). [Repo] |
| J7 ownership index | migration 0020, `packages/chain/src/twin/*`, PRs #50–#52 | Snapshot and time-weighting source (§4), only after Y0. [Repo] |
| J8 player wallets, kept separate from party wallets; `heldByYou` | 0022, PR #57 | Display only, **never a basis for allocation or payment**. [Repo] |
| `Idempotency-Key` on tenant writes; keyset paging | PRs #54, #55 | Every yield write and list. [Repo] |
| Offline retry decision for expired Token-2022 attempts | PR #58 | Pattern for "did it land?" before any payout re-attempt (future). [Repo] |
| Public read routes under `/v1/public/...` | e.g. `/v1/public/harvests/{code}`, `/v1/public/rwa/cnft/{representationId}` in `openapi.yaml`, main | The public yield summary route (§7.4). [Repo] |

**What does not exist, and must be designed or confirmed:**
- any Solana program;
- any vault, escrow or claim mechanism;
- a stablecoin rail on Solana;
- any oracle or exchange-rate source;
- any bank integration;
- any investor login (parties are records, not users);
- an auditor role;
- recorded cluster identity for the ownership index;
- any model of rental contracts, invoices or service revenue;
- any link between `business_assets` and the equipment registry;
- any grouping (pool) of compressed NFTs;
- any legal structure or entitlement instrument. [Repo, by absence]

### 0.3 Safeguards and open policies

**Safeguards** are invariants this plan requires. They are **not product options**. A proposal that
would weaken one conflicts with the plan, and must be raised as an explicit change to the plan, with
legal, product and technical review. It is not a choice inside a decision.

| Safeguard | Where defined |
| --- | --- |
| Legal entitlement documents take precedence; a cycle without an entitlement reference, or with a known conflict, is not published | §0.1 |
| The artifact set (inputs, versions, ownership source and slot range, allocation, root, evidence) is frozen before review, and approval covers exactly those hashes | §2.2 |
| Four-eyes approval (preparer ≠ approver) | §2.1 |
| Compliance checked when an intent is created, at approval and immediately before execution | §4.4 |
| Blocked or unattributed amounts are recorded and never silently redistributed | §4.3, §4.4 |
| Verified ownership-source and cluster provenance for every chain read | §4.2, Y0 |
| Fixture ownership excluded from real cycles | §4.2, §9.1 |
| Player wallets and RWA party wallets stay separate; a login never creates or derives a party | §4.3 |
| Deterministic calculation (integers, recorded rounding) and amount-bound checks (u64 leaves) | §3.2, §6.2 |
| No signing, submission, funding or payout without the separate approvals of §11 | §6.3, §11 |

Some register entries (D-15, D-16, D-17) decide **how** a safeguard is implemented. For example,
screening freshness windows, the cluster identifier, or the enforcement layers. Whether the safeguard
applies is not open.

**Open policies** stay visibly **unapproved** until decided. They include:
- the fee (D-2);
- reserves (D-6, D-7);
- loss carry-forward (D-8);
- the holding model (D-12);
- the initial asset class (D-20);
- the payout rail and custody (D-25);
- the other economic and product decisions in §12.

Provisional recommendations in this plan are labelled as such, and are **not** approvals.

**No placeholder becomes a policy.**
- Libraries take every policy value as an explicit parameter and export **no defaults** for economic
  values.
- A missing value is an error, never a default.
- Records used only for simulation are labelled `simulation`, and the database refuses to let a
  non-simulation cycle reference them (§12.1).

## 1. Scope and terminology

| Term | Definition (proposed) |
| --- | --- |
| **Entitlement instrument** | The executed legal document set that defines what holders are owed (§0.1). Identified by id, version and content hash. |
| **Yield cycle** | One accounting period for one **economic asset** (§1.1), in which proceeds are recognised, costs and reserves applied, and a net amount may be allocated. It has an id, a version, a period, a status (§2), a policy version, a formula version and an entitlement-instrument reference. |
| **Asset** | A `business_assets` row (main). Its on-chain representation (`asset_representations`) is what holders hold. |
| **Asset class** | Land/infrastructure, equipment, crop/commodity-linked, service revenue, non-yield-bearing, simulation/test (§1.1). |
| **Eligible holder** | An RWA **party** that held units through one of its registered `party_wallets` during the cycle's fixed slot range, from verified RPC-sourced ownership events. Being an eligible holder gives an *economic allocation*. **Payment eligibility is separate** (§4.4). |
| **Ownership unit** | A Token-2022 base unit, at the mint's `decimals`; or one compressed NFT (one Bubblegum asset) = 1 unit. |
| **Slot range** | `(start_slot, end_slot]` of finalized Solana slots for the cycle, fixed when the authoritative calculation runs (§2.1), from a verified cluster (Y0). |
| **Time-weighted ownership** | Σ (units × slots held) inside the slot range, from finalized ownership events (§4.2). |
| **Accounting currency** | The single currency, per cycle, in which the waterfall is computed (§3.2, D-4). |
| **Settlement unit** | The token (mint, network, decimals) in which allocations are expressed (D-3). |
| **Gross revenue** | Invoiced or contracted proceeds recognised for the period under the policy (cash or accrual, D-5). |
| **Net revenue (R)** | Gross revenue minus refunds, chargebacks and rebates, and minus taxes collected for authorities. |
| **Operating expenses (O)** | Evidence-backed costs of earning R in the period (§3.7). |
| **Maintenance and capital reserve (M)**, **climate/insurance reserve (I)** | Amounts set aside by policy. They are not expenses. Who owns them, how they're used and how they're released is D-7. |
| **Platform or operator fee (P)** | The operator's compensation. Its base, order and caps are D-2. |
| **Net distributable yield (NDY)** | What the cycle allocates to holders, ≥ 0 (§3.3). |
| **Loss** | A negative operating result. Recorded, never allocated (§3.4). |
| **Artifact set** | The frozen calculation artifact, allocation artifact, Merkle tree and evidence bundle of one cycle version (§2.2). |
| **Claim** | A holder's entitlement to one leaf of a published cycle. Not money until paid. |
| **Merkle leaf / root** | §6.2. |
| **Evidence bundle** | The canonical manifest of every evidence item (§5). |
| **Attestation** | A recorded or signed statement by an identified person about specific hashes (§5.4). |
| **Reconciliation** | Comparison of expected against actual, with a case for each difference. |
| **Correction / supersession** | A new cycle version that replaces the old artifact set (§2.4). Never an edit in place. |
| **Dispute** | A formal objection with an owner, deadline and outcome (§2.5). |

### 1.1 Asset classes

| Class | `ASSET_KINDS` today [Repo] | Yield source | Notes |
| --- | --- | --- | --- |
| Land or infrastructure | `parcel`, `building`, `storage_unit` | rent, leases, storage fees | `parcel` is a compressed-NFT kind |
| Equipment and machinery | `equipment` | rental or machinery-as-a-service | **Prerequisites missing** (§2.3, D-19) |
| Crop or commodity-linked | `tree`, `harvest_lot`, `livestock` | sale of produce | `tree` and `livestock` are compressed-NFT kinds |
| Service revenue | `storage_unit`, `logistics_lot` | packaging, cold-chain, transport | no revenue model exists yet |
| Non-yield-bearing | per entitlement instrument | none | no cycles can be created |
| Simulation/test | flagged `simulation` (new); devnet; fixture ownership | simulated only | never fundable (§9.1) |

**An economic asset** is what one cycle covers:
- a single Token-2022 share mint; or
- **one** compressed NFT.

The current index treats each Bubblegum (DAS) asset as one indexed asset (`ownershipIndexTargets`
uses `das_asset_id`, PR #50). **No grouping (pool) of compressed NFTs exists.** Whether to limit
cycles to one compressed NFT, or to introduce a pool model, is **D-18**. A pool model would need:
- a stable pool identifier;
- membership versioning;
- rules for adding or removing assets;
- economic entitlement definitions;
- prevention of double inclusion;
- legal approval.

## 2. Lifecycle

### 2.1 State machine

```
draft ──lock──► inputs_locked ──calculate──► calculated ──submit──► under_review ──approve──► approved ──publish──► published
  │                │   ▲                         │                      │                       │                     │
  │                │   └──────unlock (invalidates artifacts)───────────┘ (reject)               │                     │
  ▼                ▼                             ▼                                               ▼                     │
cancelled ◄────────┴─────────────cancel──────────┴───────────────────────────────────────────── cancelled              │
abandoned ◄── expire (pre-publication states idle past the deadline, D-10)                                             │
                                                                                                                       │
published ──close──► closed {reason: no_distribution | loss | unfunded | simulation}                                   │
published ──fund*──► funded* ──distribute*──► distributing* ──close──► closed {reason: distributed}                    │
published | funded* | distributing* ──dispute──► disputed ──dismiss──► (the state it came from)                         │
published | disputed ──supersede (an approved correction is published)──► superseded                                   │
```

`*` marks future phases. They need separate funding and execution approval, and can never be
entered while the holds apply, or by a simulation cycle.

**Terminal states:** `closed` (with a reason), `cancelled`, `abandoned`, `superseded`. All are
reachable.

**Publication is a supported state, not a required one.** A phase-1 (simulation) cycle may end at
any terminal state, including `cancelled` or `abandoned` before publication.

**Non-simulation cycles fail closed.** Each step refuses unless the approved records it needs exist:
- registering real evidence needs approved storage and retention (D-24);
- `lock` needs an approved entitlement instrument (D-1), an approved policy record (D-2…D-10,
  D-21), an approved settlement unit (D-3), and an approved asset class (D-20), with D-18 for
  compressed-NFT cycles and D-19 for equipment;
- `calculate` needs an approved holding model (D-12), a verified ownership source (D-16), and an
  approved payout wallet for every allocated party (D-14). What happens when a party has none is an
  open question (§13.2): refuse the whole cycle, or record that party's amount as withheld with no
  leaf. Until it is answered, `calculate` of a non-simulation cycle does not complete for such a
  party;
- `approve` needs an approved attestation quorum for the asset class (D-23);
- `publish` needs a named dispute authority (D-22) and, if the public summary is enabled, an approved
  public-exposure rule (D-30);
- `fund` is refused in the current phase, and always for simulation cycles.

Simulation cycles may use simulation-labelled records only, and can never be funded (§12.1).

| From → To | Command and actor (proposed permission) | Preconditions | Refused when |
| --- | --- | --- | --- |
| draft → inputs_locked | `lock`: preparer (`yield:prepare`) | period ended; required evidence registered (§5); every cost line complete (§3.7); entitlement instrument referenced (§0.1) | any of those missing |
| inputs_locked → draft | `unlock`: preparer | — | — |
| inputs_locked → calculated | **`calculate` (authoritative)**: preparer; the computation itself is pure | slot range fixed; ownership snapshot complete from **verified RPC** events and a verified cursor (Y0, §4.2); allocation, leaves, tree and artifact set produced and **frozen** (§2.2); every leaf amount fits u64 (§6.2) | ownership unknown or incomplete; fixture events in a non-simulation cycle; cluster unverified; an amount overflows. Each refusal is recorded as a failed calculation, and the cycle stays in `inputs_locked`. |
| calculated → inputs_locked | `unlock`: preparer | the artifact set is marked `invalidated` (kept, never deleted) | — |
| calculated → under_review | `submit`: preparer | — | — |
| under_review → inputs_locked | `reject`: reviewer | reason recorded; the artifact set is invalidated | — |
| under_review → approved | `approve`: reviewer ≠ preparer (`yield:approve`) | attestation quorum on the **artifact-set hashes**, from an **approved** quorum record for the asset class (D-23; none → refused); no open dispute; compliance snapshot recorded (§4.4) | same person as preparer (four-eyes, as `rwa_orders_four_eyes`); quorum missing; the set changed since attestation |
| approved → published | `publish`: approver | approved artifact set unchanged; for non-simulation cycles, a named dispute authority (D-22) | any hash mismatch; no dispute authority (non-simulation) |
| any pre-publication state → cancelled | `cancel`: approver | reason | — |
| any pre-publication state → abandoned | system, after the inactivity deadline (D-10) | — | — |
| published → closed | `close`: approver | reason `no_distribution` (NDY = 0), `loss`, `simulation`, or `unfunded` (a decision not to fund) | open dispute |
| published → disputed; funded/distributing → disputed | `dispute`: authorised raiser (D-22) | — | closed or superseded |
| disputed → the prior state | `dismiss`: dispute authority | reasons recorded | — |
| published/disputed → superseded | `supersede`: approver, by publishing an approved correction version | correction approved through the same path | correction not approved |
| published → funded → distributing → closed | **future** | separate approvals (§6.3) | always, in the current phase and for simulation cycles |
| anything else | — | — | always; enforced by a transition trigger, as for `chain_operations` (0011) |

Every transition is written to an append-only transition log (actor, time, reason, artifact-set
hash), on the pattern of `chain_operation_transitions` (0011).

**Two kinds of calculation:**
- **Preview** (`POST …/preview`) is pure and returns numbers. It changes no state and stores
  nothing authoritative.
- **Authoritative calculation** (`POST …/calculate`) creates a versioned, frozen artifact set and
  moves the cycle to `calculated`.

### 2.2 Order of work, and what approval covers

1. Cycle inputs are locked (`lock`).
2. The eligible slot range is fixed (`calculate`, step a).
3. The ownership snapshot is completed from verified, finalized, RPC-sourced events (step b).
4. Unknown or incomplete ownership blocks progression (step b fails).
5. The waterfall and the allocations are calculated (step c).
6. Canonical leaves and the Merkle tree are generated (step d).
7. **Frozen artifact set:** the calculation artifact, allocation artifact, evidence bundle and Merkle
   root, each with its SHA-256 (step e).
8. Reviewers attest to those hashes (`under_review`).
9. Four-eyes approval (`approve`).
10. The approved root and artifacts are published (`publish`).
11. Funding and execution are separate, later phases (§6.3).

**Approval covers:**
- the calculation inputs (input-set hash);
- the formula, policy and entitlement-instrument versions and hashes;
- the ownership source (verified cluster identity, cursor) and the slot range;
- the allocation table;
- the Merkle root;
- the evidence and attestation bundle.

All of these are part of the hashed artifact set, so changing any of them invalidates the approval.

### 2.3 Lifecycles by business model

| Model | Inputs | Evidence | Gates and calculation notes | Dispute and correction |
| --- | --- | --- | --- | --- |
| **Crop production and physical sale** | harvest volume and grade, sale contracts, invoices, receipts, costs | harvest batch (0004), weighbridge and warehouse receipts, invoices, settlement records, cost receipts; agronomist and auditor attestations | R by cash or accrual (D-5) | quality or weight dispute → correction version |
| **Equipment rental / MaaS** | rental contracts, hours used, rates, maintenance | **Not supported until the prerequisites in D-19 exist.** Today: `business_assets` of kind `equipment` is not linked to the `equipment` registry (0011 against 0007); `meter_readings` are user-recorded hours per date (`hours`, `read_on`, `recorded_by`; 0007), not tamper-evident telemetry; no rental contracts, invoices or service revenue are modelled. No link between sensors and equipment was found in 0008. [Repo] | — | billing dispute |
| **Storage, packaging, cold-chain** | contracts, throughput, temperature logs | warehouse receipts; IoT data; invoices. Revenue is not modelled yet. | — | spoilage dispute |
| **Zero yield** | as for the model | the same evidence: a zero must be as well evidenced as a profit | NDY = 0 → `close` with reason `no_distribution` | the same |
| **Loss-making** | as for the model | the same | loss recorded (§3.4) → `close` with reason `loss` | the same |
| **Revenue received, evidence disputed** | as for the model | plus the dispute | blocked in review, or `disputed` after publication | dismiss or correct |
| **Partial payment** | invoices, partial receipts | receipts showing the paid share | cash basis: received only; accrual: receivable with a bad-debt policy (D-5) | a late receipt goes into a later cycle |
| **Currency conversion** | lines in several currencies | FX records (§3.2) | per D-4 | FX dispute → correction |
| **Cancelled or superseded** | — | reason | `cancel` before publication; `supersede` after | — |

### 2.4 Corrections and supersession

- A correction is version *n+1* of the same cycle. It goes through `draft → … → published` again,
  with its own artifact set, and references version *n*'s artifact-set hash.
- Publishing version *n+1* moves version *n* to `superseded`:
  - version *n*'s artifact set stays stored and readable, marked superseded, never deleted;
  - its unclaimed claims become `voided`;
  - in a future on-chain model, its root would be closed.
- Holders paid under version *n* get **delta** entries: positive, or negative to be netted later,
  subject to D-10. [Legal]
- Before publication, any change to the inputs or the snapshot means `unlock`. That invalidates the
  frozen set; a new `calculate` creates a new set, and the old one is retained as `invalidated`.

### 2.5 Disputes

- A dispute has a subject (an evidence item, the calculation or an allocation leaf), a raiser, a
  reason, a deadline, an assignee and an outcome (`dismissed`, `corrected`, `withdrawn`).
- While a dispute is open, the cycle cannot be funded or distributed (future), and views show
  "disputed".
- Who may raise disputes, and the dispute authority: **D-22**.

## 3. Financial calculation model

### 3.1 The proposed formula, examined

`NDY_c = max(0, R_c − (O_c + M_c + I_c + P_c))` leaves five things undefined:
1. **the fee base**;
2. **whether reserves are expenses**: they are retained balances, not costs;
3. **what happens to losses**: `max(0, …)` erases them;
4. **the order of operations**;
5. **taxes, refunds, bad debt, currency effects and rounding.**

This plan therefore uses an explicit waterfall. The fee base is left open, with alternatives.

### 3.2 Units, currencies and rounding

- **Accounting currency (D-4):** one fiat currency per cycle, in **minor units** with its ISO 4217
  exponent, e.g. USD with exponent 2. The whole waterfall is computed in it. A cycle never mixes
  units without the conversion rules below.
- **Line conversion (D-4):** each revenue or expense line in another currency converts to the
  accounting currency at the rate for a **defined date**. The options are transaction date,
  settlement (cash) date, evidence date, or cycle close.
  - *Provisional proposal:* the **settlement date** for revenue under the cash basis and for paid
    expenses, because that is when value actually moved.
  - The rate is a rational `num/den` from an **approved source** (D-4), with a UTC timestamp and the
    source's identifier.
  - **FX sources are D-4 only.** D-33 covers non-FX data (e.g. weather, market prices) used as
    evidence. No oracle supplies revenue: revenue always comes from evidence (§5). Neither decision
    substitutes for the other.
  - Local dates resolve to UTC using the evidence's IANA time zone.
- **Unavailable or corrected rates:**
  - an unavailable rate **blocks `lock`**;
  - a rate corrected after publication goes into a correction version (§2.4);
  - rates are never estimated.
- **Conversion fees** are expenses (O). **Realised FX differences** (rate used against rate actually
  obtained) go into the next cycle as a separate line. They never reopen a published cycle.
- **Accounting → settlement:** the final NDY converts **once**, at the frozen cycle-close rate of
  accounting currency → settlement unit (D-3, D-4), into **base units of the settlement token**. A
  pegged token still needs a recorded rate (e.g. 1/1, with its source), never an assumption.
- **Arithmetic:** integers only. Each division rounds **down**, and the dropped fraction is recorded.
- **Allocation rounding:**
  - the largest-remainder method;
  - ties broken by ascending recipient bytes;
  - anything that cannot be allocated is the remainder, handled per D-9.
- **Remainder and dust are different things, with rules that don't conflict:**
  - **The remainder** is NDY minus the sum of the floored allocations. D-9 decides whether it is
    allocated by largest remainder or carried to the next cycle. It is never paid to anyone outside
    the allocation.
  - **Dust** is a party's allocation *after* the remainder step that falls below a payment threshold
    (D-9). It stays allocated to that party and is recorded, but its payment is deferred, accumulated
    per party for a later cycle.
  - Dust never flows back into the remainder or to other parties.
- **Widths:** internal accounting uses `numeric(78,0)` (as on main). Claim leaves are **u64** (§6.2).
- **Reproducibility:** a pure function `(inputs, policy, formula, entitlement ref, ownership events,
  rates) → artifact set`, with no clock, I/O or randomness. The same inputs give the same bytes and
  hashes.

### 3.3 Waterfall and fee alternatives (D-2)

Notation (accounting currency, minor units):

```
R    = gross − refunds − chargebacks − rebates − taxes collected
O    = operating expenses (§3.7)
OR   = R − O                                  operating result; may be negative
LCF  = loss carried forward from earlier cycles (D-8); LCF_used = min(max(OR, 0), LCF)
OR'  = OR − LCF_used
M, I = reserve additions (D-6), computed on OR' when OR' > 0, else 0
P    = fee, by the chosen alternative below
REL  = approved reserve releases (D-7)
NDY  = max(0, OR' − M − I − P + REL)          then converted to settlement base units (§3.2)
```

When OR ≤ 0: no reserve additions, NDY = 0, and the loss |OR| is recorded (§3.4). Whether a fee is
still payable in that case depends on the alternative.

| Alternative | Fee base | Fee in a loss cycle? | Notes |
| --- | --- | --- | --- |
| **F1** | `p% × R` (verified net revenue) | **yes**, unless capped or waived | simple; the operator is paid regardless of the result |
| **F2** | `p% × OR'` (operating result after losses, before reserves) | no | the fee is not reduced by reserves |
| **F3** | `p% × (OR' − M − I)` (after reserve allocations) | no | the fee is subordinated to reserves and carried losses |
| **F4** | fixed or tiered amount, capped (e.g. ≤ q% of R) | per terms | predictable; must be disclosed as payable even in a loss cycle |

**D-2 must decide:**
- the fee base, and where it sits in the order of operations;
- a percentage or fixed amount;
- a minimum and a maximum (cap);
- whether a fee is payable in a loss cycle;
- whether the fee is subordinated to reserve requirements and to carried losses;
- consistency with the entitlement instrument (§0.1).

**The examples below use F3 purely for illustration. This is not a selection.**

### 3.4 Specific treatments

| Item | Proposed treatment | Decision |
| --- | --- | --- |
| Refunds and chargebacks | Reduce R in the cycle where they arise. After publication, a negative line in the next cycle (never a reopen). | D-5 |
| Taxes collected (VAT/GST) | Excluded from R | [Legal] |
| Withholding and holder taxes | Outside the waterfall; per-holder deduction if required | D-34 [Legal] |
| Transport, storage, commissions | O, with evidence | — |
| Bad debt | Cash basis: never in R. Accrual: O when written off under policy | D-5 |
| Negative result | Loss recorded; NDY = 0; carried per D-8; reserve offset only if D-7 allows | D-7, D-8 |
| Zero result | NDY = 0; `close` with reason `no_distribution` | — |
| Revising a cycle | Correction versions only (§2.4) | D-10 |
| Overpayment and underpayment | Deltas in the correction; netting or recovery per D-10 | D-10 [Legal] |
| Double counting | Each evidence hash and each source reference (e.g. invoice number) backs at most one live cycle input; enforced by unique constraints (§7) | — |

### 3.5 Reserves (D-7)

**Do not assume reserves are legally available to cover losses until D-7 is approved.** [Legal]

D-7 must decide:
- **Ownership:** whether reserves belong to the asset, the cycle, the holders (as of when?), the
  operator, or a separate legal entity (an SPV or trustee).
- **Segregation:** whether balances are segregated funds or only accounting entries.
- **Drawdown:**
  - whether the climate or insurance reserve (I) may offset eligible losses, and which losses count;
  - the evidence required (e.g. an insurer's assessment, or a weather data attestation);
  - the authorisation (four-eyes, plus attestation).
- **Carry-forward and release:** whether balances roll over; the conditions and approvals for
  releasing them into a cycle (REL).
- **Disposition:** treatment when the asset is retired, sold, destroyed or removed, and when the
  holder population changes (which holders benefit from a release).
- **No double use:** reserve movements form an append-only ledger per asset (add, use, release),
  each movement referencing its cycle and evidence, and a balance can never go below zero
  (DB check, plus the ledger).

### 3.6 Examples

All numbers are fictional. They use F3 for illustration only.
- **Policy:** m = 10% and i = 5% of OR'; p = 10% of (OR' − M − I); carry-forward on; no releases.
- **Accounting currency:** USD (exponent 2).
- **Settlement unit:** a USD-referenced token with 6 decimals, at a recorded 1/1 rate.
- **Conversion:** USD minor units × 10^4 = base units.

**A. Positive yield, one month, one asset:**
- R = 12,400.00 − 400.00 refunds = 12,000.00; O = 7,000.00 → OR = 5,000.00.
- No losses carried, so OR' = 5,000.00.
- M = 500.00; I = 250.00; fee base = 4,250.00 → P = 425.00.
- **NDY = 3,825.00 USD = 3,825,000,000 base units.**
- For comparison, with the same inputs:
  - F1 at 10% of R: P = 1,200.00 → NDY = 3,050.00;
  - F2 at 10% of OR': P = 500.00 → NDY = 3,750.00;
  - F4, a fixed 300.00 fee: NDY = 3,950.00.

**B. Zero yield:** R = 6,000.00, O = 6,000.00 → OR = 0 → NDY = 0. `close` with reason
`no_distribution`.

**C. Loss-making cycle, then recovery:**
- Cycle 1: R = 2,000.00, O = 9,500.00 → OR = −7,500.00. Loss 7,500.00 carried; NDY = 0; `close`
  with reason `loss`.
- Cycle 2: OR = 10,000.00 → LCF_used = 7,500.00 → OR' = 2,500.00 → M = 250.00, I = 125.00 → fee
  base 2,125.00 → P = 212.50 → **NDY = 1,912.50**.
- If D-7 instead allowed the climate reserve to offset the cycle 1 loss, these numbers would differ.
  That is not assumed here.

**D. Partial payment, cash basis:** invoiced 20,000.00, received 12,000.00 → R = 12,000.00. The
8,000.00 enters a later cycle when received. With O = 7,000.00, the numbers equal example A.

**E. Multiple currencies, per-line conversion at the settlement date:**
- Revenue of 10,000.00 EUR (1,000,000 minor), received on 2026-09-30. The recorded rate is 1.0850
  USD/EUR = 217/200, from an approved source at 2026-09-30T16:00:00Z.
- 1,000,000 × 217 / 200 = **1,085,000 USD minor = 10,850.00 USD**.
- The bank's conversion fee of 21.70 USD (0.2%) is in O.
- Any later realised difference goes into the next cycle.

**F. Rounding remainder:**
- NDY = 1,000,000 base units; three holders with equal weight.
- Floors are 333,333 ×3 = 999,999, leaving a remainder of 1.
- Largest remainder, tie broken by ascending recipient bytes → **333,334 / 333,333 / 333,333**;
  nothing left over.
- If D-9 instead says "never allocate remainders", the 1 unit goes to the next cycle.

**G. Overflow guard:** an allocation of 2^64 base units or more cannot be encoded (§6.2). `calculate`
fails deterministically with `amount_out_of_range`, and the cycle stays in `inputs_locked`.

### 3.7 Cost completeness

- Existing `cost` and `currency` columns in inventory (0005) and `service_records` (0007) are
  **nullable** [Repo]. **A missing value is unknown, never zero.**
- A cost line in a cycle needs an explicit amount (possibly an explicit `0`, with a reason), a
  currency, and evidence (§5), or a documented reason why none exists.
- `lock` is **blocked** while any cost line flagged *material* has an unknown amount.
  - Material means above a threshold, or of a mandatory category per asset class.
- **Exceptions (D-21):** an estimated cost only with an approved, attested estimate, labelled
  `estimated`, and trued up in a later cycle. Otherwise no exceptions.

### 3.8 Versioning and hashes

- `formula_version` (e.g. `yield-formula/1`) names a pure domain function. A new version never
  changes how old cycles were calculated.
- **Policy versions** (rates, fee alternative, caps) are approved four-eyes, referenced by hash, and
  never change for an already locked cycle.
- **A configurable calculation library is not an approved calculation policy.**
  - The library (Y2) implements the alternatives (F1–F4, conversion rules, rounding variants) as
    parameters.
  - Only an approved policy record selects among them for real cycles.
  - Test and illustrative policies (including examples A–G) are labelled `simulation`.
- The artifact set is canonical JSON (`canonicalJson`, main) plus the tree. It contains:
  - the input hashes;
  - the entitlement reference;
  - the policy and formula versions;
  - the rates;
  - the ownership-source identity and the slot range;
  - every waterfall line;
  - allocations;
  - the remainder;
  - the root.

  Each part's SHA-256, and the set's hash, are recorded and attested.

## 4. Holder eligibility, allocation and payment

### 4.1 Allocation models compared

| Model | Fairness | Complexity | Transferability | Flash-holding | Sybil / wash | Token-2022 | Compressed NFT | J7 index [Repo] | Auditability | Legal / UX |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Point-in-time snapshot | low near the cutoff | low | free | poor | high | yes | yes (one asset) | yes: events up to a slot | high | rewards timing |
| Time-weighted (slots) | high | medium | free | good | low | yes | yes: 0/1 per asset | yes: events carry slots; block times are **not** stored | high | "earned for time held" |
| Minimum holding period | medium | low–medium | free | good | medium | yes | yes | yes | high | must be disclosed |
| Epoch-based | medium–high | medium | free | medium | medium | yes | yes | yes | high | understandable |
| Lock-up with transfer restrictions | high | high | restricted | excellent | low | possible via Token-2022 extensions on a new mint [Ext] | Bubblegum delegation or freezing [Ext] | yes | high | changes the product [Legal] |
| Hybrid | high | medium–high | free | excellent | low | yes | yes | yes | high | most explaining |

### 4.2 Provisional recommendation (D-12) and ownership-source rules

- **Phase 1 (simulation):** time-weighted by **slots**, with a point-in-time view alongside for
  comparison. Weighting by wall-clock time needs block times, which the index doesn't store.
- **Slots and elapsed time can give different results.** Slot duration varies [Ext: Solana slot
  timing]. A holder through a period of slow slots holds for more real time per slot than a holder
  through fast slots, so slot weighting and elapsed-time weighting can allocate differently.
  - Choosing elapsed time also requires recording block times, which is extra build scope.
  - D-12 must therefore decide this before Y5 is scoped, not only before it is used.
- **Verified provenance is not complete history.**
  - Cluster verification (Y0) establishes *which chain* the events come from.
  - It does not prove that the node returned the asset's *complete* history.
  - The existing sources refuse a first window with no mint: the Token-2022 check was added in PR #52,
    where the Bubblegum source also lives. They cannot detect a node that dropped only some early
    history, according to the J7 documentation
    (`docs/ownership-index.md`, PR #52).
  - Completeness therefore also depends on using a node that keeps full history [Ext].
  - The ownership-source record (§7.2) should state how that was established.
- **Ownership source:** the J7 index (`chain_ownership_events`, cursor `indexed_through_slot`,
  migration 0020, PR #50) **after Y0**. Every event and cursor used must come from a source whose
  cluster identity was **verified and recorded**. The genesis hash is **not stored today**; storing
  it is a proposed addition (Y0, D-16).
- **Fixture exclusion (D-17):**
  - a real or legally effective cycle may use only events and cursors with `source = 'rpc'` from a
    verified source;
  - `source = 'fixture'` events (an allowed value in 0020) are permitted only in simulation, tests
    and demonstrations;
  - a tree that contains fixture ownership is simulation-only: never fundable, executable or
    publishable as real.
- **Amount bound:** the index stores amounts as u64 values (`amount <= 18446744073709551615`, 0020).
  Weights (units × slots) are computed in arbitrary precision; only final allocations must fit u64.

### 4.3 Rules

| Topic | Rule (proposed) |
| --- | --- |
| Eligibility cutoff | `(start_slot, end_slot]`, finalized, fixed by `calculate`. The mapping from the period's wall-clock bounds to slots is recorded as evidence. |
| Snapshot completeness | The asset's verified cursor must be ≥ `end_slot`. `not_indexed`, conflicts, an unverified cluster or fixture data block `calculate` (non-simulation). |
| Transfers near the cutoff | Counted in proportion to slots held. Same-slot order follows the index; conflicts fail closed. |
| Several wallets of one party | Holdings summed per party over its registered `party_wallets` (unique per tenant, network and address, 0012). One allocation per party. |
| Payout destination | A party's designated payout wallet: a **new concept** (no such field exists). D-14. |
| Lost or inaccessible wallets | The allocation stays with the party, not the address. Re-designation needs KYC re-verification, four-eyes approval and a cooling-off period. D-14 [Legal] |
| **Player wallets vs party wallets** | **Player wallets never create, imply or receive an allocation or a payment.** A player-only address is *unattributed*. Any account-to-party association is explicit, consented, authorised, revocable and audited (D-29). A login never creates, owns or derives a party. |
| Unattributed holders | Counted in the denominator; their share is computed, recorded and **not paid**. Hold, release or exclude is D-13; it is never silently redistributed. |
| Unknown ownership | Blocks the cycle. Never "nobody holds". |
| Test assets | Simulation cycles only (D-17). |
| Ownership changes during disputes | No effect: the slot range is fixed. |
| Fractional units, dust | Integer weights; dust below a threshold is accumulated per party (D-9). |

### 4.4 Allocation eligibility and payment eligibility are different

- **An allocation is economic:** what the cycle attributes to a party.
- **Payment is gated.** A party may have an allocation while payment stays **blocked** until legal
  and compliance requirements are met.
- **Blocked amounts are withheld and recorded, never redistributed** (D-13, D-15).

**Compliance is checked at three points**, following the existing order pattern (main: `gate()` in
`rwa.ts` lines 143–148 and 366; `engine.ts` line 630). D-15 confirms this:
1. **When a payout or claim intent is created.**
2. **At four-eyes approval** of the payout (or batch of payouts).
3. **Immediately before execution or settlement (future).** This check must:
   - re-screen the **party** (KYC current, jurisdiction allowed, sanctions screening clear and recent);
   - re-screen the **exact payout destination** (wallet screening clear and recent);
   - confirm the destination is **still registered to the same eligible party**;
   - confirm the **network, mint and amount** match the approved payout;
   - **block payment** if any result is expired, changed, unavailable or negative, and open a case.

## 5. Evidence and attestation

### 5.1 Separation

| Layer | Content | Where |
| --- | --- | --- |
| Evidence storage | the bytes | private object storage through `@metafarm/storage` (PR #43), behind the content-store interface (PR #41) |
| Metadata | type, issuer, fields, times, classification | `yield_evidence` (§7) |
| Hash | SHA-256 of the exact bytes | metadata, plus a `data_commitments` row (0019, PR #40; a new subject type `evidence` would be a widening CHECK) |
| Attestation | who vouches for which hashes | `yield_attestations` |
| On-chain anchor | the root of an evidence batch or the claim tree | **plan only** (`planAnchor`, PR #41; endpoints PR #43) |

**Bundle manifest:** canonical JSON `{scheme: "metafarm-yield-evidence/1", cycleId, cycleVersion,
items: [...]}`, with items sorted by (type, contentSha256). Its hash is part of the artifact set.

### 5.2 Evidence types

Every item records:
- `contentSha256`, `byteSize`, `mediaType`;
- `issuedAt` (RFC 3339 with offset), plus `timeZone` (IANA) for local-date documents;
- `sourceId`, `recordedBy`, `recordedAt`;
- `classification`;
- `supersedes`.

Corrections add a new superseding item. Revocation is a revoking attestation. Nothing is deleted
except under a retention policy.

| Type | Issuer | Key fields | Format | Signature / attestation | Retention | Classification |
| --- | --- | --- | --- | --- | --- | --- |
| Weighbridge receipt | operator | gross, tare, net, unit, vehicle, lot | PDF/image + JSON | stamp or signature; scanned | per law [Legal] | confidential |
| Warehouse receipt | warehouse | lot, quantity, grade, period | PDF + JSON | issued by the warehouse; may be a document of title [Legal] | per law [Legal] | confidential |
| Sales invoice | seller | buyer (pseudonymised), lines, taxes, totals | PDF/XML; e-invoice formats where applicable [Ext] | e-invoice signature where available [Ext] | per tax law [Legal] | confidential, may hold PII |
| Export and customs records | broker or authority | declaration, HS code, values | PDF/XML | authority reference | per law [Legal] | confidential |
| Bank or settlement record | bank | masked account, amount, value date, reference | CSV/PDF/API | bank-issued; confirmed by an auditor | per law [Legal] | **restricted** |
| Stablecoin settlement record | chain | network, signature, mint, amount, from/to | JSON of a finalized transaction | **verified from the chain** at finality, from a verified cluster (Y0) | per policy [Legal] | confidential |
| Equipment telemetry | device or platform | device, window, hours, readings | rollup JSON (0017) | device identity: MQTT client certificates are configurable (`MQTT_CLIENT_CERT_PEM`), but binding devices to equipment and to their identity is **not confirmed** [Ext] | per policy | internal |
| IoT data | device | sensor, window, series hash | JSON | as above [Ext] | per policy | internal |
| Weather data | provider | station or grid, window, variables | JSON | provider reference; licence terms | per licence | internal |
| Auditor or expert attestation | identified person | scope, item hashes, opinion | signed PDF + JSON | per D-23 | per law [Legal] | confidential |

Personal data and commercial terms stay in private storage. Public outputs carry totals and hashes
only (§7.4). [Legal: data protection]

### 5.3 Storage options (D-24)

| Option | Availability | Privacy | Durability | Retention control | Cost | Legal risk |
| --- | --- | --- | --- | --- | --- | --- |
| Private object storage (abstracted, PR #43) | provider SLA | private | provider; versioning or object lock [Ext] | full | low | low |
| IPFS with pinning | depends on pinning | public if the CID is known | paid pinning | weak | low–medium | high for PII or commercial data |
| Arweave | permanent | public | permanent | none | one-off | high: erasure impossible |
| Hybrid (private bytes, public hashes and manifests) | good | good | good | good | low | low |

*Provisional recommendation:* the hybrid. IPFS or Arweave only for content meant to be public, with
no PII.

### 5.4 Attestations (D-23)

An attestation is `{attester, role, statement, subject hashes, issuedAt, method, signature or
reference}`. The available methods:
- **recorded:** an authenticated user with the attester role; audited;
- **document signature:** the signed PDF's hash is stored;
- **key signature:** an Ed25519 or ECDSA signature over a domain-separated message, **verified,
  never produced**, by the platform.

The quorum per asset class is D-23.

## 6. Merkle distribution and claims

### 6.1 Pipeline

The phase-1 steps are simulation and verification only:

1. Register inputs and evidence.
2. `lock`.
3. **`calculate`:**
   - fix the slot range;
   - complete the verified snapshot;
   - waterfall;
   - allocation;
   - leaves;
   - tree;
   - freeze the artifact set.
4. Store the artifacts (content store); record the hashes.
5. Attestation and review (`under_review`).
6. Four-eyes `approve`.
7. `publish` (internal; the public summary per §7.4).
8. *Future:* fund (separate approval).
9. Serve proofs (read-only; holder access per §7.3).
10. Reconciliation (simulated in phase 1).
11. `close` or `supersede`.

### 6.2 Canonical leaf

- **Hash:** `leaf = SHA-256(0x00 ‖ SHA-256(leaf_bytes))`, with interior nodes `SHA-256(0x01 ‖ l ‖ r)`.
  This is the RFC 9162 construction of `commitments.ts` (PR #40), with its own domain tag.
- **On-chain verification:** an on-chain verifier could recompute SHA-256 through Solana's hashing
  support. Its availability and cost are an **external assumption to verify** before D-26. [Ext]

`leaf_bytes` is little-endian, with every field fixed-size:

| Field | Bytes | Notes |
| --- | --- | --- |
| domain tag | 32 | `SHA-256("metafarm-yield-leaf/1")` |
| network id | 1 | registry constant |
| cluster identity | 32 | the genesis hash recorded by **Y0** (proposed; **not stored today**) |
| cycle id | 16 | UUID bytes |
| cycle version | 4 | u32 |
| epoch | 4 | u32 (0 when unused) |
| economic asset id | 32 | the Token-2022 mint, or the compressed-NFT asset id (one asset per cycle unless D-18 approves pools) |
| recipient | 32 | the party's payout wallet (Solana). A TRON payout would need a different leaf variant, out of scope under the TRON hold |
| payout mint | 32 | the settlement token |
| **amount** | **8** | **u64** in settlement base units |
| formula version | 2 | u16 |
| leaf-layout version | 2 | u16 |
| leaf index | 4 | u32 |

**Amount width:**
- SPL token amounts are u64 [Ext: SPL semantics]; the index already bounds amounts to u64 [Repo].
- Before encoding, each `numeric(78,0)` allocation is checked against `0 < amount ≤ 18446744073709551615`.
- Any failure makes `calculate` fail deterministically (`amount_out_of_range`).
- The internal accounting width (`numeric(78,0)`) is distinct from the canonical leaf width (u64).

**Order and uniqueness:**
- leaves are ordered by recipient bytes;
- each tree has a unique (tree, recipient) pair, so there is one leaf per payout wallet per cycle
  version.

**Replay protection:**
- the domain tag, network, cluster identity, cycle id and version make a leaf valid for one tree only;
- a future claim program would also keep a per-root claimed-bitmap.

### 6.3 Stages

| Stage | Phase 1 |
| --- | --- |
| Off-chain calculation, artifact set | yes |
| Off-chain publication (internal; public summary) | yes |
| On-chain root anchoring | **plan only** (`executable: false`) |
| Vault funding | **no**: no program exists; needs separate approval |
| On-chain claim | **no**: no program exists |
| Off-chain push payout (distribution orders, TRON) | **no**: RWA execution and TRON holds |
| Reconciliation | simulated |

**Future boundary (D-25):** a Solana claim program, if chosen, would need:
- a vault per cycle owned by a program address;
- a root per cycle version;
- a claimed-bitmap;
- `claim(leaf, proof)` checking the domain tag, network, cluster, root and bit;
- an admin path for supersession and closure, with timelock and multisig.

It would need its own design, audit and approval. [Ext for the program design]

### 6.4 Push or pull, and custody (D-25)

**Push** uses the existing model: one `distribution` order per party, with a TRON TRC-20 settlement
from **`RWA_TRON_TREASURY`** (main configuration).
- This means an **operator-controlled treasury temporarily or operationally controls funds intended
  for recipients**. The legal and regulatory consequences need qualified review. [Legal]
- Before any live execution, these must be addressed:
  - treasury reconciliation;
  - segregation of client funds;
  - treatment in the operator's insolvency;
  - access control;
  - signing governance (KMS/HSM, multisig);
  - incident recovery.

**Pull** means holders claim from a funded vault. It needs a program, an audit, wallet UX, and
holders paying network fees unless they are sponsored. Custody questions apply to the vault as well.

### 6.5 Claims

- **Status:** `pending` → `claimable` → `claim_intent_created` → `submitted`* → `claimed` | `failed` |
  `expired` | `voided` (superseded) | `withheld` (compliance).
- **Idempotency:** `(cycle, version, leaf index)`. A repeated request returns the same unsigned
  intent (the TTL pattern of PR #41).
- **Partial failure:** a submitted claim that has not been observed is never re-sent (`outcomeUnknown`,
  main). It is re-checked as in PR #58.
- **Expiry and unclaimed funds:** D-27 [Legal: unclaimed property].
- **Double claim:** the off-chain uniqueness and status machine, plus a future on-chain bitmap.
- **Finality:** everything is read at `finalized`, from a verified cluster.
- **Devnet and mainnet:** different network id and cluster identity in the leaf. Mainnet stays
  locked (`RWA_MAINNET_ENABLED`).

**Phase 1 produces only** artifacts, proofs, **unsigned** claim intents and simulated
reconciliation. It never signs, submits, funds or claims anything.

## 7. Database and API plan

Plain SQL migrations, RLS with `FORCE ROW LEVEL SECURITY`, `metafarm_app`, typed repositories, zod,
OpenAPI. **No migration is written here.** The numbering would continue after 0022.

### 7.1 Reuse

| Existing | Use |
| --- | --- |
| `data_commitments`, `commitment_batches` (0019, PR #40) | Evidence and artifact hashes, and their batching |
| `parties`, `party_wallets` and the compliance gate (main) | Eligibility and payment gating |
| `reconciliation_cases` (main; keyed to `rwa_orders`) | Payout-level cases only, if payouts are distribution orders. Cycle-level differences need `yield_reconciliations`. |
| Idempotency (PR #54) and paging (PR #55) | Every write and list |
| Audit storage | **D-31** (below) |

### 7.2 Proposed tables (all tenant-scoped with RLS)

| Table | Key points |
| --- | --- |
| `yield_cycles` | id; (tenant, economic asset, period, version) unique; status; `simulation` bool; entitlement instrument id, version and hash; policy and formula versions; accounting currency; settlement mint and decimals; slot range; ownership-source identity (Y0); artifact-set hash; root. Columns frozen by a trigger after `calculate`. |
| `yield_cycle_transitions` | append-only; actor, reason, artifact-set hash |
| `yield_artifact_sets` | id; (cycle, version, set number) unique; status `frozen`/`invalidated`/`approved`/`superseded`; the hashes of every part; append-only apart from a status column guarded by a trigger |
| `yield_inputs` (revenue and expense lines; reviewer's choice whether expenses are separate) | append-only; side and kind; amount in `numeric(78,0)` minor units; currency; `completeness` (`known`/`zero`/`estimated`); evidence hash; **unique (tenant, source_kind, source_ref) across live cycles**, to prevent double counting |
| `yield_reserve_movements` | append-only ledger per asset: add, use, release; balance ≥ 0 by check; each movement references its cycle and evidence |
| `yield_policies` | append-only, versioned; basis points and caps as integers; four-eyes; policy hash |
| `yield_fx_rates` | append-only; source, pair, at; `num`/`den` as `numeric(78,0)`; record hash |
| `yield_evidence` | append-only; (tenant, content_sha256, type) unique; supersedes; classification; retention class |
| `yield_attestations` | append-only; (artifact set, attester, statement) unique; revocations as new rows |
| `yield_ownership_snapshots` | append-only; cycle; source identity; cursor slot; events hash; **`source_kind` CHECK (`rpc`), unless the cycle is a simulation** (enforced by a trigger joining `yield_cycles.simulation`) |
| `yield_allocations` | append-only; (artifact set, party) unique; kind (`allocated`, `unattributed`, `withheld`, `dust`); weights; `numeric(78,0)` amount |
| `yield_merkle_trees`, `yield_merkle_leaves` | append-only; (tree, recipient) unique; leaf bytes and hash; amount ≤ u64 max by CHECK |
| `yield_claims` (+ transitions) | status machine; idempotency key; phase 1 holds intents only |
| `yield_reconciliations`, `yield_disputes`, `yield_corrections` | resolution rows append-only |
| `ownership_source_identities` (Y0) | network; verified genesis hash; endpoint fingerprint (scheme and host only, never credentials); verified_at; verifier. Referenced by cursors and snapshots. *Proposed.* |

All timestamps are `timestamptz` (UTC), with IANA zones stored where local dates matter. Indexes go
on `(tenant_id, status, created_at)` and on every foreign key. Retention follows §5.2.

**Access:** the app role gets SELECT/INSERT on fact tables, and UPDATE only on guarded status
columns.

**D-31: audit storage.** Reuse `audit_events`, or add a dedicated `yield_audit_events`?

| Aspect | Reuse `audit_events` (0001) | Dedicated `yield_audit_events` |
| --- | --- | --- |
| Append-only | already enforced (trigger, 0001 lines 431–446) | needs `append_only()` (0011) |
| RLS | per the existing setup | defined fresh, yield-specific |
| Query performance | shared table; filter by action prefix and tenant | narrower table; indexes tuned for yield |
| Retention | one policy for every audit event | can differ (e.g. longer for financial records) [Legal] |
| Isolation | mixed with operational events | isolated |
| Export | one export path | a separate, yield-only export (e.g. for auditors) |
| Migration complexity | none | one more table and its grants |

*Provisional recommendation:* reuse `audit_events` for *who did what*, and keep state history in
the append-only transition logs. This is not settled; it is D-31.

### 7.3 API (proposed; under `/v1/tenants/{tenantId}/yield`; `Idempotency-Key` on writes; keyset paging on lists)

| Endpoint | Purpose | Authorization |
| --- | --- | --- |
| `POST /cycles` | create a draft | `yield:prepare` |
| `POST /cycles/{id}/evidence`, `/inputs` | register evidence metadata and lines | `yield:prepare` |
| `POST /cycles/{id}/lock`, `/unlock` | lock or unlock inputs | `yield:prepare` |
| `POST /cycles/{id}/preview` | **non-mutating** calculation | `yield:prepare`, `yield:review` |
| `POST /cycles/{id}/calculate` | **authoritative**: freezes the artifact set → `calculated` | `yield:prepare` |
| `POST /cycles/{id}/submit`, `/reject` | review flow | `yield:prepare` / `yield:review` |
| `POST /cycles/{id}/attestations` | attest to artifact-set hashes | `yield:attest` |
| `POST /cycles/{id}/approve` | four-eyes | `yield:approve` (≠ preparer) |
| `POST /cycles/{id}/publish`, `/close`, `/cancel` | publish or close | `yield:approve` |
| `POST /cycles/{id}/disputes`, `/corrections` | disputes and corrections | per D-22 / `yield:approve` |
| `GET /cycles`, `GET /cycles/{id}`, `GET /cycles/{id}/audit` | operator views | `yield:read`; `audit:read` for the trail |
| **Holder-facing:** `GET …/my-allocations`, `GET …/proofs/{leafIndex}`, `POST …/claims/{leafIndex}/intent` | the holder's allocation, proof and **unsigned** intent | **only after the account-to-party linking of D-29 exists**; compliance checkpoint 1 (§4.4) at intent creation |

**Roles (D-28):** existing roles on main are owner, admin, manager, verifier, worker and viewer
(`packages/domain/src/roles.ts`).

| Role | Access |
| --- | --- |
| Admin | owner or admin |
| Operator | manager + `yield:prepare` |
| Auditor | a new role, or `verifier` extended: `yield:read`, `yield:attest`, `yield:review`, `audit:read`, but not `prepare` or `approve` |
| Asset manager | `yield:approve` |
| Player | `heldByYou` and public summaries only |
| Linked player wallet | display only, never a payout identity |
| RWA party | holder-facing endpoints only through an explicit, consented, authorised, revocable and audited account-to-party link (D-29). A login never creates or derives a party. |
| Public | §7.4 |

### 7.4 Public summary

`GET /v1/public/yield/cycles/{cycleId}`, following the `/v1/public/...` convention on main, returns
only:
- status, period;
- formula and policy versions;
- totals (R, O, M, I, P, NDY) in the accounting currency, if D-30 allows publishing totals at all;
- the root and the artifact-set hash.

It **never** returns:
- evidence bytes or private attestations;
- holder allocations or wallet addresses;
- compliance status;
- counterparties, prices, or other commercially sensitive records.

D-30 decides the details.

## 8. Unity and web

**Unity engine-free core:** read-only DTOs, GET only, netstandard2.1. The reflection test that
forbids signing types (PR #40) covers them.

| Model | Contents |
| --- | --- |
| `YieldCycleSummary` | status, period, formula version, totals with their currency, `lastUpdated`, dispute/correction flags, `isSimulation` |
| `YieldVerification` | root, artifact-set hash, attestation count against quorum, and a proof result re-checked locally with `Rfc9162CommitmentVerifier` |
| `YieldAllocationView` | amount and claimable state, shown **only** through the D-29 party link |

**`heldByYou`** keeps J8's rule:
- true only from verified chain readings;
- absent for unknown ownership, test data, or a user with no linked wallet;
- never false-for-unknown.

It is **not** an allocation indicator.

| UI state | Shown as |
| --- | --- |
| Draft | "Being prepared" |
| Under review | "Awaiting independent review" |
| Approved | "Approved, not yet published" |
| Published | "Published, with verification details" |
| Claimable | future |
| Claimed | future |
| Partially claimed | future |
| Disputed | "Disputed: payouts paused" |
| Superseded | "Replaced by version n+1", with a link |
| No yield | "No distribution", with the reason |
| Loss-making | the loss amount and its carry-forward effect |
| Verification unavailable | never shown as verified |
| Ownership unavailable | "not indexed", never "you hold nothing" |

**Disclosures** (governed by D-39):
- every yield view links to the risk disclosure [Legal];
- each view shows the waterfall lines separately, uses past tense, and makes no projections or
  guarantees;
- the 3D or metaverse presentation never replaces financial or legal disclosures, and uses no game
  vocabulary for money.

**Web:** read-only pages on the `/rwa` pattern (PR #39, main), with paging (PR #55).

## 9. Security, compliance and operations

### 9.1 Invariants

1. No key material stored; no backend signing; no submission in any phase before Y16.
2. The Unity core stays read-only.
3. Player and party wallets stay separate: no allocation or payment from a player wallet, and no
   implicit account-to-party link.
4. Verification only; never transaction signing.
5. Domain-separated messages and leaves.
6. Replay protection: network, verified cluster identity, cycle and version in each leaf;
   single-use intents.
7. Idempotent writes, with unique constraints as the backstop.
8. Four-eyes: preparer ≠ approver; attesters are identified.
9. Immutable evidence and artifact sets, with supersession instead of edits.
10. Audit integrity (D-31, D-32).
11. No double allocation or double counting (unique sources; one leaf per recipient).
12. No double claim.
13. **Cluster identity verified and recorded for every chain read (Y0).**
14. **Fixture ownership never in a real cycle (D-17):**
    - DB: a trigger on snapshots;
    - service: `calculate` refuses;
    - tests: fixture events plus a non-simulation cycle → refused.
15. **Compliance checked at intent, at approval, and before execution; blocked amounts withheld, not
    redistributed.**
16. Legal precedence: no publication without an entitlement reference, or with a known conflict.
17. Amounts bounded to u64 at the leaf.
18. Secret redaction (existing logger); no credential-bearing URLs (Y0 records the scheme and host
    only).
19. PII and commercial data private.
20. Rate limits (PR #53).
21. Sybil resistance through party KYC.
22. Disaster recovery: artifact sets can be reproduced from inputs and stored events, and backup
    restores are checked by hash.

### 9.2 Compliance workstream ([Legal] throughout; no conclusions)

| Area | Questions for counsel |
| --- | --- |
| Entitlement instruments | Form, governing law, amendment process (D-1) |
| Securities or collective investment | Classification of the share tokens and the yield in each jurisdiction (D-34) |
| Commodities and warehouse receipts | Whether receipts used as evidence are documents of title |
| Payments, e-money and **custody** | **Push from `RWA_TRON_TREASURY` puts funds intended for recipients under operator control.** Treasury reconciliation, segregation, insolvency treatment, access control, signing governance and incident recovery must be resolved before live execution (D-25). A vault in the pull model raises the same questions. |
| AML/KYC and sanctions | Screening at intent, approval and execution; travel-rule data |
| Tax | Withholding; holder statements |
| Consumer disclosures | No guarantees; the waterfall shown in full |
| Cross-border | Currency controls; geographic availability (D-35) |
| Data protection | PII in evidence; retention against erasure |
| Advertising | Yield wording on the web and in Unity |

## 10. Testing strategy

| Test | Fixtures | Invariant | CI without external services? |
| --- | --- | --- | --- |
| Waterfall F1–F4 | examples A–F | exact minor and base units | yes |
| Overflow | example G; 2^64−1 and 2^64 | deterministic `amount_out_of_range` | yes |
| Leaf serialization | the §6.2 layout vectors, TS and C# | identical bytes; u64 little-endian | yes (TS + C# jobs) |
| Rounding | exponents 0/2/3; decimals 0/6/9 | Σ allocations + remainder = NDY | yes |
| Currency | per-line conversion; missing rate blocks `lock` | determinism; no floats | yes |
| Cost completeness | unknown against zero; material threshold | `lock` refused | yes |
| Reserves | add/use/release ledger | balance ≥ 0; no double use | yes (DB) |
| Evidence and canonical JSON | known bytes | stable hashes | yes |
| Merkle proofs | 1, 2, 3, 2^n, 2^n+1 leaves | RFC 9162 behaviour | yes |
| Snapshot and time-weighting | ownership-event fixtures | weights match hand tables | yes |
| Transfer at cutoff | events at `end_slot` and `end_slot+1` | included / excluded | yes |
| Multiple wallets | a party with three wallets | one allocation | yes |
| Unknown ownership | cursor behind; conflict | `calculate` refused | yes |
| **Fixture exclusion** | fixture events in a non-simulation cycle | refused by service and DB | yes (DB) |
| **Cluster identity (Y0)** | mismatch, missing identity, configuration mismatch, provenance | refused | yes (stubbed RPC) |
| Unattributed and withheld | a player-only holder; a blocked party | recorded, not paid, not redistributed | yes |
| **Compliance checkpoints** | expiry between approval and execution; destination re-registered | blocked at the next checkpoint | yes (DB) |
| State machine | every transition, both valid and invalid; terminal reachability | trigger refuses invalid ones | yes (DB) |
| Freeze and approval | a change after attestation | approval refused | yes (DB) |
| Corrections | version n → n+1 | old set superseded; deltas | yes (DB) |
| Idempotency, authorization, contract | as existing | four-eyes; routes match OpenAPI | yes |
| Unity read-only | reflection | GET only | yes (C#) |
| Browser | pages; disclosures; no "guaranteed" | axe clean | yes (Playwright) |
| Devnet | live index | matches the explorer | **no**: after the holds lift |
| Unity Editor and IL2CPP | read models | — | **no**: Unity 6 machine |

**Technical verification is not legal review or human approval.**
- Browser and accessibility tests can check that the approved disclosure text **is present**, that
  prohibited wording is **absent**, and that pages are accessible.
- They **cannot** establish that a disclosure is legally adequate. That needs counsel (D-39).
- Likewise, passing tests never substitute for the approvals in §12.

## 11. Delivery roadmap

**Every PR below is a proposal.**
- Listing a PR, or its dependencies, authorises nothing.
- Each PR needs the owner's explicit authorisation to **begin**, in addition to the decisions it lists.
- Dependencies are *proposed*. **No PR, including Y0, is approved.**

**Placement:**
- a separate feature stack, never appended to or modifying the frozen #40–#59 stack (merge order and
  blast radius in `docs/delivery/readiness.md`);
- based on `feature/retire-evm-wallet-link` (#59) for anything that needs draft capabilities;
- retargeted to `main` after #40–#59 merge.

**Independence from the draft stack:**
- **Y1** needs only `packages/domain`, which is on main.
- **Y2** needs only Y1 and `canonicalJson`, which is on main (`packages/domain/src/harvest.ts` line 91).

These are verified for the files named, and no further. Y3 onwards depends on draft capabilities.

**Gate columns:**
- **Decisions to build:** must be approved before the PR is written.
- **Decisions to use:** must be approved before the PR's output may be configured or used for a
  real economic cycle.
- **Permitted while open:** what may be built without those decisions, and how it fails closed.

### 11.1 Gates by PR

| PR | Scope | Decisions to build | Decisions to use (real cycles) | Predecessors (proposed) and draft-stack dependencies | Permitted while decisions are open; fail-closed behaviour | Acceptance criteria | Blocks operational use until | Approval to begin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Y0** | Cluster identity for ownership sources: verify the RPC cluster, record the verified identity, bind sources and cursors to it, reject mismatches | **D-16** (identifier, storage, binding) | — | base #59; J7 code from #50–#52 (**not modified**: a new PR on top) | — | stubbed-RPC tests for mismatch, missing identity, configuration mismatch and provenance; unverified sources refused | the deploy hold lifts and J7 is enabled by the owner | owner authorisation + D-16 (T); **proposed** security sign-off (S, §11.2) |
| Y1 | Vocabulary, state machine, invariants (types and docs) | none | — | main (`packages/domain`) | the whole PR; no policy values | transition-table tests; invalid transitions refused | — | owner authorisation |
| Y2 | Configurable calculation library: F1–F4, conversion rules, rounding variants, u64 bound, artifact hash | none | D-1, D-2, D-4, D-5, D-6, D-7, D-8, D-9, D-10, D-21 (via approved policy records) | Y1; main `canonicalJson` | the whole library; **no exported economic defaults**; a missing parameter is an error; examples A–G as `simulation` fixtures | examples A–G exact under each alternative; overflow is deterministic; same inputs give the same hash | the policy records are approved | owner authorisation |
| Y3 | Evidence and attestation model (manifest, types, signature *verification*) | none | D-23 (methods allowed for real attestations), D-24 (retention classes) | Y1; **PR #40** (`commitments.ts`) | the model supports all three attestation methods as types; real attestations refused without an approved method list | hash vectors; manifest reproducible | D-23 and D-24 approved | owner authorisation |
| Y4 | Evidence storage wiring (private object storage) | none for the private-storage wiring; **D-24** before any public-storage option (IPFS, Arweave) is built | D-24 (real evidence, retention) | Y3; **PR #41** (interface); **PR #43** (`@metafarm/storage`) | private storage, plus an in-memory store for tests; non-simulation evidence registration refused until D-24. Y4 does not select a D-24 option: the private adapter sits behind the content-store interface, and stays limited to tests and simulation if D-24 chooses otherwise | bytes and hashes match; integrity errors refused | D-24 approved | owner authorisation; data-protection review [Legal] |
| Y5 | Allocation from verified ownership events; fixture exclusion; unattributed and withheld recording | **D-12 (slots or elapsed time)**, D-17 (enforcement layers). D-18 only if a pool model is to be built; single-asset scope needs no D-18 | D-12 (model selection), D-13 (disposition) | **Y0**, Y2; #52 | snapshot and slot-weighted models; one asset per cycle; unattributed and withheld amounts recorded, never redistributed or disposed | weights match fixtures; fixture data in a non-simulation cycle refused; unknown ownership refused | D-12 approved; Y0 operational. (D-13 blocks only the disposition of unattributed or withheld amounts, which stay recorded and unpaid until it is approved.) | owner authorisation |
| Y6 | Canonical leaves and proofs (TS and C#), u64 | **D-26** (hash function) | — | Y5; PR #40 (C# verifier) | — | the same leaf bytes in TS and C#; proofs verify; overflow refused | — | owner authorisation + D-26 (T) |
| Y7 | Schema, append-only triggers, RLS (§7.2) | **D-31** (audit storage), **D-17** (database enforcement of fixture exclusion) | — | Y0–Y6; PR #40 (`data_commitments`); migrations after 0022 (#57) | simulation-label constraints included | constraint and trigger tests; simulation records can't be referenced by non-simulation cycles | — | owner authorisation + D-31 (T, L); **proposed** S sign-off (RLS) |
| Y8 | Operator read API; public summary | **D-28** (roles and permissions) | **D-30** (public summary) | Y7; #54, #55 | operator read API; the `/v1/public/...` route is **not registered** until D-30 | contract and authorisation tests; nothing sensitive public | D-30 approved for the public route | owner authorisation + D-28 (T, P) |
| Y9 | Preparer and reviewer workflow (`lock` … `publish`, `close`); preview against `calculate` | **D-11** (confirm the freeze is implemented at `calculate`) | D-1, D-2…D-10, D-21, D-3, D-20 (with D-18 / D-19 for those classes) (lock); D-12, D-14 (calculate); D-23 (approve); D-22 (publish) | Y8 | the full workflow for **simulation** cycles; non-simulation cycles fail closed at each gate (§2.1); without D-21, no estimates (unknown material cost blocks `lock`) | four-eyes enforced; preview changes nothing; gates refuse without approved records | each listed decision is approved | owner authorisation + D-11 confirmation (P, T) |
| Y10 | Web read-only pages | none for internal (staff) pages behind a flag that is off by default | **D-39** (disclosure version) before any non-staff audience; D-30 for public pages | Y8 | internal pages show "not an approved disclosure"; the flag can't be enabled in deployed environments without an approved disclosure version | Playwright and axe; approved disclosure present; prohibited wording absent (technical checks only, §10) | D-39 approved for that audience | owner authorisation |
| Y11 | Unity read models | none | D-39 before user-facing text | Y8; PR #40 (C# core) | DTOs only; GET only | C# and reflection tests | **Unity 6 validation**; D-39 | owner authorisation |
| Y12 | Login-to-party link (explicit, consented, authorised, revocable, audited) | **D-29** | — | Y8 | — | a link never creates or derives a party; revocation and audit tests | D-29; [Legal] consent wording (D-39) | owner authorisation + D-29 (L, P, T); **proposed** S sign-off |
| Y13 | Holder-facing allocations, proofs, **unsigned** claim intents | — | D-15 (screening details) before any non-simulation intent; D-25 before any intent tied to a payout rail; D-27 before claims expire; D-39 holder disclosures | **Y12**, Y6, Y9 | simulation-labelled, unsigned intents over leaf data only; no rail-specific payout fields; no expiry action; compliance checkpoint 1 runs | intents deterministic; nothing signed or submitted; compliance refusals recorded | D-15, D-25, D-27 and D-39 approved | owner authorisation |
| Y14 | Simulation and reconciliation tools | none | — | Y9, Y13 | simulation only | reports reconcile | — | owner authorisation |
| Y15 | Devnet-only, **read-only** verification: snapshots and allocations computed from a live devnet index (with Y0 verification) and compared with the explorer. **No settlement, payout, funding or claim is exercised in Y15.** | — | Whether devnet cycles are simulation-labelled is **open** (§13.2). If simulation-labelled: none beyond the simulation records. If non-simulation: every Real gate of §2.1 applies (including D-1, D-3, D-14, D-22, D-23, D-24). **D-3 and D-14 are not otherwise required for Y15.** Any devnet settlement or claim exercise is a separate, separately approved scope, gated by D-3, D-14, D-25 (design) and D-27. | Y0, Y14; the **deploy hold lifted** | read-only devnet checks only | matches the explorer | — | **separate devnet approval** by the owner; **proposed** S and O sign-off |
| Y16 | Solana program / on-chain anchoring | D-25 (design), D-26, D-27 | — | separate approval | — | program audit [Ext] | — | **separate approval**; L, T, P; **proposed** S and O sign-off |
| Y17 | Live claim or settlement | all production decisions (§12.2, group 8) | — | separate approval | — | — | — | **legal, security, operations and deployment approval**; this plan authorises none |

### 11.2 Sign-off gap (proposed for review)

The register uses L, P and T only. Several milestones need sign-offs that the model doesn't name:
- Y0, Y7 and Y12: security, for provenance, RLS and identity linking;
- Y15, Y16 and Y17, and D-25: security and operations, for custody, keys and incident recovery.

**Proposal, for the owner to accept or reject:** add explicit milestone sign-offs, **S** (security
review) and **O** (operations readiness), at the PRs marked above. This plan does not name who holds
them.

**Coverage gap:** D-19 (linking assets to equipment, contract records, revenue evidence, telemetry
provenance) has no PR in Y0–Y17. Supporting the equipment class would need an additional, separately
approved PR. Until then the equipment class stays unsupported (§2.3).

Rollback for Y0–Y14 is a revert. Additive migrations have down migrations, which are blocked in
deployed environments (`downMigrationBlocked`, main).

## 12. Decision register

**Timing key:**
- **Build** = before implementing the reusable interface or library that needs it;
- **Real** = before configuring or using it for a real (non-simulation) economic cycle;
- **Dev** = before devnet integration;
- **Prod** = before production.

"Staged" entries are detailed in §12.1.

**Approval key:** **L** = legal/compliance; **P** = product; **T** = technical. Proposed S and O
sign-offs are in §11.2. Recommendations marked *provisional* are **not** approvals.

| # | Question | Options | Provisional recommendation | Approvers | Timing | If unresolved |
| --- | --- | --- | --- | --- | --- | --- |
| D-1 | Authoritative entitlement instrument: which documents, versioning and hashing, approver, amendments for existing and future cycles, precedence | token terms / offering docs / asset agreements | legal documents prevail (a **safeguard**, §0.3); instrument hash per cycle; amendments apply to cycles locked after approval | L, P, T | **Real**, per asset class; before implementing any asset-class-specific support | no non-simulation cycle can `lock` |
| D-2 | Fee: base, order, % or fixed, minimum and maximum, fee in a loss cycle, subordination | F1 / F2 / F3 / F4 (§3.3) | none selected (examples use F3 for illustration only) | P, L | Real | no approved policy; `lock` refused for real cycles |
| D-3 | Settlement units and mints | per network or token | — | P, T, L | **Staged** (§12.1) | — |
| D-4 | Accounting currency and FX (conversion date, approved FX sources, time zones, missing and corrected rates, fees, realised differences, final conversion) | §3.2 | per line at the settlement date; one final conversion at close; a missing rate blocks `lock` | P, T, L | Real | multi-currency real cycles refused |
| D-5 | Cash or accrual; receivables; bad debt; refunds after publication | — | cash basis | P, L | Real | policy incomplete; `lock` refused |
| D-6 | Reserve rates and caps (M, I) | percentages / schedules | — | P, L | Real | policy incomplete; `lock` refused (no implicit zero) |
| D-7 | Reserve ownership, segregation, drawdown, release, disposition, double use | §3.5 | not usable for losses until approved | L, P | Real | drawdown and release refused |
| D-8 | Loss carry-forward | on / off / with expiry | on, no expiry, pending counsel | P, L | Real | policy incomplete; `lock` refused |
| D-9 | Remainder rule; dust threshold | allocate / carry; threshold value | largest remainder; dust carried per party (§3.2) | P, T | Real | policy incomplete; `lock` refused |
| D-10 | Corrections; overpayment netting or recovery; abandonment deadline | §2.4 | §2.4 | P, L | Real | corrections allowed only for simulation cycles |
| D-11 | Confirm how the freeze is implemented: the freeze point is `calculate` (a **safeguard**, §0.3) | freeze at `calculate` (the only option consistent with §0.3; freezing at publication would conflict with it) | at `calculate` | P, T | **Build** (Y9) | Y9 can't be written |
| D-12 | Holding model; slots or elapsed time | §4.1 | time-weighted by slots | P, T, L | **Build** (slots or time, which sets Y5's scope); **Real** (model selection) | Y5 scope undefined / real allocation refused |
| D-13 | Disposition of unattributed and withheld shares | hold / release / exclude from the denominator | hold, with expiry per D-27. Recording without redistribution is a **safeguard**; only the *disposition* is open | P, L | Real | amounts stay recorded and unpaid |
| D-14 | Payout-wallet designation; lost wallets | — | per party, four-eyes, cooling-off | P, L | **Real** (designation, before `calculate` of a non-simulation cycle, because each leaf names the party's payout wallet, §6.2); **Dev** (re-designation, only within a separately approved devnet settlement scope, not Y15); **Prod** (lost-wallet recovery) | `calculate` of a non-simulation cycle does not complete for a party without an approved payout wallet (refuse the cycle or withhold without a leaf: open, §13.2) |
| D-15 | **Implementation details** of the three compliance checks (providers, freshness windows, case handling). The three checks themselves are a **safeguard** | — | adopt the existing pattern (main) | L, T | Real (before any non-simulation intent) | non-simulation intents refused |
| D-16 | Cluster identifier, storage and binding (provenance is a **safeguard**) | genesis hash / another approved identifier; separate table / cursor columns | genesis hash per source (Y0) | T | **Build** (Y0) | Y0 can't be written; Y5 onwards blocked |
| D-17 | Enforcement layers for fixture exclusion (exclusion is a **safeguard**) | DB / service / tests | all three | T | **Build** (Y5, Y7) | Y5 and Y7 can't be written |
| D-18 | Compressed-NFT scope | one per cycle / pool model (§1.1) | none selected | P, L, T | **Build** only if pools are chosen; **Real** for cNFT classes | single-asset only; cNFT real cycles refused |
| D-19 | Linking assets to equipment, contracts, revenue evidence, telemetry provenance | — | required before any equipment class | P, T | Build (for equipment support); Real | equipment class unsupported |
| D-20 | Initial asset class | undecided / equipment after D-19 / another class | **left undecided** | P | Real | no first real cycle |
| D-21 | Exceptions for missing costs | none / attested estimates | attested estimates only | P, L | Real (only to allow estimates) | no exceptions: unknown material costs block `lock` |
| D-22 | Dispute authority and raisers | — | — | P, L | **Staged** (§12.1) | — |
| D-23 | Attestation methods and quorum | §5.4 | — | P, T, L | **Staged** (§12.1) | — |
| D-24 | Evidence storage and retention | §5.3 | hybrid | T, L | **Staged** (§12.1) | — |
| D-25 | Payout rail (push or pull), program design, custody | §6.4 | none selected | L, T, P (+ proposed S, O) | **Staged** (§12.1) | — |
| D-26 | Claim-tree hash function | SHA-256 / Keccak | SHA-256, pending on-chain cost verification [Ext] | T | **Build** (Y6) | Y6 can't be written |
| D-27 | Claim expiry, unclaimed funds, fee sponsorship | — | — | P, L | **Staged** (§12.1) | — |
| D-28 | Roles and permissions | new `yield:*`; auditor role or `verifier` extended | new `yield:*` permissions | T, P | **Build** (Y8) | Y8 can't be written |
| D-29 | Login-to-party link | explicit, consented, authorised, revocable, audited | required for Y12/Y13 | P, L, T | **Build** (Y12) | no holder-facing endpoints |
| D-30 | Public exposure | root, status, hashes / plus totals | root, status and hashes; totals only if approved | P, L | Real (public route) | public route not registered |
| D-31 | Audit storage | reuse `audit_events` / `yield_audit_events` (§7.2) | reuse, plus transition logs | T, L | **Build** (Y7) | Y7 can't be written |
| D-32 | Audit hash-chaining and export | — | — | T | Prod | — |
| D-33 | Non-FX data sources used as evidence (weather, market prices); **not** FX (D-4), **not** a revenue source | — | — | T, L | Real (only if such data is used) | such data can't be used as evidence |
| D-34 | Legal classification; tax withholding | — | — | L | Prod (before any public launch) | no launch |
| D-35 | Geographic availability | — | — | L | Prod | no launch |
| D-36 | Auto-compounding | — | no | P, L | Prod | none |
| D-37 | Governance or reputation tokens | — | none | P, L | Prod | none |
| D-38 | Platform token | — | none | P, L | Prod | none |
| **D-39** | **Disclosure governance** (below) | — | — | **L**, P (+ translation review) | **Staged** by audience (below) | no disclosure-dependent surface beyond internal staff |

**D-39: disclosure governance** [Legal throughout]. D-39 must decide:
- **Who** drafts, reviews and approves financial and risk disclosures. The approval is legal, and
  needs qualified counsel.
- **Which disclosures each audience needs:**
  - **internal simulation:** staff-only labelling ("simulation, not a financial result");
  - **authenticated previews:** before any non-staff user sees yield figures (Y10, Y11, Y13);
  - **public launch:** before any public page (with D-30, D-34, D-35);
  - **live payouts:** before Y17.
- **Versioning:** each disclosure version is hashed and associated with the entitlement instrument
  (D-1) and the product release it covers.
- **User acknowledgement**, where counsel says it is legally required.
- **Translation review**: e.g. Persian alongside English, as the web app supports both.
- **Correcting or withdrawing** a misleading disclosure, including notifying affected users where
  required.
- **Preventing guaranteed-income claims and misleading game framing.** This is checked technically
  (prohibited-wording tests, §10), but adequacy is a legal judgement.

### 12.1 Staged decisions: what may proceed, and how it fails closed

| Decision | (a) Before a reusable interface or library | (b) Before a real economic cycle | (c) Before devnet | (d) Before production |
| --- | --- | --- | --- | --- |
| **D-3** settlement units | Not needed. Libraries take the mint, network and decimals as parameters; tests use simulation mints. | An approved settlement-unit registry entry is needed before a non-simulation cycle can `lock`; otherwise refused. | A devnet mint approved, only if devnet work converts or settles. | Production mints, with custody (D-25). |
| **D-22** dispute authority | Not needed. Y9 may implement dispute *recording* by internal reviewers (`yield:review`); holder-raised disputes are not built. | A named dispute authority is needed before a non-simulation cycle can `publish`; otherwise refused. | Whether holders may raise disputes on devnet (needs Y12). | Final authority, deadlines and holder access. |
| **D-23** attestation | Not needed. Y3/Y9 implement the methods as types and the quorum as data. | An approved quorum and method list per asset class are needed before `approve` of a non-simulation cycle; otherwise refused. Simulation cycles use a simulation-labelled quorum. | As (b), for devnet cycles. | Key-signature methods and attester identity requirements confirmed. |
| **D-24** evidence storage | Not needed for private object storage (Y4). **Needed** before building any public-storage integration (IPFS, Arweave). | Approved storage and retention are needed before **real evidence** (PII, commercial data) is registered; otherwise refused. | The devnet storage configuration. | Retention schedule and data-protection compliance [Legal]. |
| **D-25** payout rail and custody | Not needed for unsigned, simulation-labelled intents over leaf data. **Needed** before building any rail-specific payout logic (distribution-order creation, or a claim program). | **Not needed to publish.** A real cycle may publish and then `close` as `unfunded`. Needed before any funding. | The design, if devnet exercises a payout or claim. | Use: custody, segregation, insolvency, access control, signing governance and incident recovery resolved (+ proposed S, O) [Legal]. |
| **D-27** claim expiry | Not needed. The status machine includes `expired`, with expiry as a parameter. **With none approved, no claim expires and nothing is released** (fail closed). | Not needed to publish (claims aren't claimable without funding). | Needed if devnet claims exercise expiry. | Expiry, unclaimed-funds treatment and fee sponsorship [Legal]. |
| **D-39** disclosures | Not needed. Internal staff pages carry a "not an approved disclosure" banner. | Not needed for staff-only simulation. | Before any non-staff user sees devnet yield figures. | Before public launch and before live payouts. |

**Fail-closed mechanism** (for Y7/Y9 to implement, proposed):
- policy, quorum, storage, settlement-unit and disclosure records carry a status (`draft`,
  `approved`, `simulation`);
- non-simulation cycles may reference only `approved` records (database check plus service check);
- simulation records are refused for non-simulation cycles;
- simulation cycles can never enter `funded`.

### 12.2 Decision-gate matrix

| Group | Decisions | Approvers | Approval would unblock | It would not authorise | Evidence needed |
| --- | --- | --- | --- | --- | --- |
| **1. Technical foundations** | D-16, D-17, D-26, D-28, D-31, D-11, D-12 (slots or time) | T (D-11, D-12, D-28: + P; D-12: + L; D-31: + L); proposed S for D-16 and D-31 | writing Y0, Y5, Y6, Y7, Y8, Y9 | real cycles, devnet, enabling J7 or any deployment | Y0 design note; RPC cluster-identity behaviour [Ext]; schema and RLS review; on-chain hash cost [Ext] |
| **2. Initial asset class and legal entitlement** | D-1, D-20, D-18, D-19; D-34 (scoping) | L, P, T | asset-class-specific work; real cycles for that class can `lock` (with group 3) | publication to the public, payouts, launch | executed or draft entitlement instruments; counsel's classification view; asset–equipment link design (if equipment) |
| **3. Calculation and economic policy** | D-2, D-3 (real settlement unit), D-4, D-5, D-6, D-7, D-8, D-9, D-10, D-21, D-33 | P, L (D-4, D-9: + T; D-33: T, L) | approved policy records, so real cycles can `lock` and `calculate` | funding or payouts; the fee or reserve terms as legal terms (those come from D-1) | modelled scenarios (A–G and variants); counsel on reserves and losses; approved FX source terms |
| **4. Ownership and eligibility** | D-12 (model), D-13 (disposition), D-15 (details), D-14 (payout-wallet designation, needed at `calculate`) | P, L, T | real allocations; non-simulation intents (D-15) | payouts; holder access | simulations over devnet event data (when permitted); screening-provider terms |
| **5. Evidence, approval, disputes and audit** | D-22, D-23, D-24, D-32 | P, T, L | approving and publishing real cycles; registering real evidence | public exposure (D-30); payouts | data classification; retention advice [Legal]; attester identity requirements |
| **6. Holder access and disclosures** | D-29, D-30, D-39 | L, P, T | Y12, Y13 and Y10/Y11 beyond staff; the public summary route | claims, funding or payments | consent and linking design; approved disclosure texts and translations [Legal] |
| **7. Devnet** | D-24, D-22/D-23 (if devnet cycles are non-simulation, open in §13.2); D-3, D-14, D-25 design and D-27 only for a separately approved devnet settlement scope (not Y15) | P, T, L; proposed S, O | Y15, given separate devnet approval and the deploy hold lifted | mainnet, production, live settlement | Y0 operational; a full-history RPC confirmed [Ext]; devnet runbook |
| **8. Production custody and settlement** | D-25 (use), D-3 (prod), D-14, D-27, D-32, D-34, D-35, D-36, D-37, D-38, D-39 (live) | L, P, T; proposed S, O | consideration of Y16 and Y17 | live payouts on its own: those still need deployment and execution approval | custody and segregation analysis [Legal]; signing governance design; incident-recovery plan; audit of any program [Ext] |

### 12.3 Renumbering history

**Revision 3 adds D-39 and renumbers nothing.**

Revision 2 renumbered revision 1's decisions as follows:

| Revision 1 | Revision 2 |
| --- | --- |
| D-1 (fee) | D-2 |
| D-2 (settlement units) | D-3 |
| D-3 (cash or accrual) | D-5 |
| D-4 (reserve rates) | D-6 |
| D-5 (reserve release) | D-7 |
| D-6 (loss carry-forward) | D-8 |
| D-7 (rounding) | D-9 |
| D-8 (corrections) | D-10 |
| D-9 (disputes) | D-22 |
| D-10 (attestation) | D-23 |
| D-11 (storage) | D-24 |
| D-12 (holding model) | D-12 |
| D-13 (unattributed) | D-13 |
| D-14 (payout wallet) | D-14 |
| D-15 (classification) | D-34 |
| D-16 (push or pull) | D-25 |
| D-17 (hash) | D-26 |
| D-18 (expiry) | D-27 |
| D-19 (roles) | D-28 |
| D-20 (investor identity) | D-29 |
| D-21 (public) | D-30 |
| D-22 (audit chaining) | D-32 |
| D-23 (oracles) | D-4 and D-33 |
| D-24 (geography) | D-35 |
| D-25 (compounding) | D-36 |
| D-26 (governance tokens) | D-37 |
| D-27 (platform token) | D-38 |
| D-28 (initial class) | D-20 |

## 13. Clarifications and open questions

### 13.1 Clarifications (revision 3)

1. **Publication is supported, not required.** A phase-1 cycle may end `cancelled` or `abandoned`
   without publishing (§2.1).
2. **Verified provenance is not complete history.** Y0 proves which chain; completeness also depends
   on a full-history node and the first-window checks, which cannot detect partial pruning (§4.2)
   [Ext].
3. **Slots and elapsed time differ economically,** because slot durations vary. D-12 decides which,
   before Y5 is scoped (§4.2) [Ext].
4. **Remainder and dust are distinct.** The remainder is unallocated units handled by D-9; dust is
   allocated but deferred payment. Neither flows to the other or to other parties (§3.2).
5. **FX (D-4) and non-FX data (D-33) are separate decisions.** Neither is a source of revenue (§3.2).
6. **Browser and accessibility tests** check presence, prohibited wording and accessibility. They do
   **not** establish legal adequacy, which needs counsel under D-39 (§10).

### 13.2 Open questions (revision 4)

These are unresolved. Nothing in this plan answers them, and none has a provisional recommendation
unless stated.

1. **Are devnet (Y15) cycles always simulation-labelled, or may they be non-simulation?** The answer
   decides which Real gates apply to Y15 (§11.1). Owner decision (2026-10-21): left open.
2. **What does `calculate` do for an allocated party with no approved payout wallet (D-14)?**
   - (a) refuse the whole cycle (fail closed);
   - (b) produce no leaf for that party and record its amount as withheld, not redistributed
     (consistent with §4.3).

   Owner decision (2026-10-21): left open.
3. **What does `close` with reason `unfunded` mean for allocations and claims?** Voided, deferred,
   or carried forward. Under the legal-precedence safeguard (§0.1), closing must not be read as
   extinguishing holder entitlements. [Legal]
4. **Does designing the Y16 program need D-27 at build time?** Y16 lists D-27 under "decisions to
   build", while §12.1 needs D-27 only at stages (c) and (d).
5. **Should a leaf's recipient be a payout wallet at all,** or a party-scoped identifier resolved
   to a wallet at payout? The identifier would remove the Real gate on D-14, but change the claim
   design (D-25, D-26). §6.2 currently assumes a wallet.
