# Real yield distribution layer: plan

**Status: proposal for review. Nothing here is approved, implemented, migrated or deployed.**
Every recommendation is provisional until the owner approves it, and every item marked
**[Legal]** needs qualified counsel. This document gives no legal conclusions.

**Inspected:**
- the draft stack top, `feature/retire-evm-wallet-link` @ `ebb3f56` (PR #59, which contains #40–#59);
- `main` @ `b59eaff`.

Where this document says something **exists**, it names the file. It says "on `main`" or "draft
#NN" for where the thing lives.

## 0. What exists today, and what this plan builds on

**Correction to the brief:** the backend is **Fastify 5 with plain SQL migrations** (`packages/db/migrations/NNNN_*.up.sql`,
row-level security, `withTenant`/`withSystem`), **not NestJS or Drizzle**. There is no ORM. The schema
proposals in §7 follow the repository's real convention: SQL migrations, typed repository functions
in `packages/db/src/repositories`, and zod contracts. TimescaleDB is optional (`0017_telemetry_rollups` falls back to a view
without it), and MQTT over TLS exists (`apps/worker/src/telemetry`).

| Existing building block | Where | Reuse in this plan |
| --- | --- | --- |
| Money as integer base units, `numeric(78,0)` | `rwa_orders.settlement_amount`, `settlement_intents.amount` (main, 0011/0012) | The same representation for every on-chain amount. Fiat stays in minor units (§3.2). |
| Per-investor **`distribution` order**: money only, paid as a TRON TRC-20 settlement intent to a party's wallet, with four-eyes approval | `packages/domain/src/rwa/orders.ts`, migrations 0012 and 0015, `POST …/rwa/orders/{id}/approve` (main) | A possible future **push payout** rail (§6.4). A yield cycle would *produce* distribution orders; it never pays by itself. Executing them stays under the RWA and TRON holds. |
| Compliance gate: KYC, jurisdiction, screenings; anything unknown blocks | `packages/domain/src/rwa/compliance.ts` (main) | Eligibility for payout (§4). |
| RWA parties and `party_wallets` (Solana and TRON networks) | migration 0012 (main) | The **only** identity that can receive yield. |
| Reconciliation cases, keyed by `reconciliation_id` of an order | `reconciliation_cases` (main) | Payout reconciliation when payouts are distribution orders. Yield-level reconciliation needs its own table (§7). |
| Append-only trigger `append_only()`; append-only `audit_events` | migrations 0001 and 0012 (main) | Every yield fact and audit table (§7). |
| Inputs and equipment costs with `numeric(15,2)` and an ISO currency | `inventory_*` (0005), `service_records` (0007) (main) | Candidate *sources* of operating-cost lines, copied into a cycle as evidence-backed inputs, never read live. |
| Harvest batches with a canonical public record and `record_hash` | migration 0004 (main) | Evidence for crop volume. |
| Hour meters and telemetry rollups | 0007, 0008, 0017 (main) | Evidence for equipment-service revenue (usage). |
| Data commitments; RFC 9162 Merkle (`metafarm-merkle-sha256/1`); proofs re-checked on read | `packages/domain/src/twin/commitments.ts`, migration 0019 (draft #40) | Evidence hashing and evidence batches (§5). The claim tree reuses the hash construction, with its own domain tag (§6.2). |
| Canonical JSON | `canonicalJson` in `packages/domain/src/harvest.ts` (main), used by snapshots (draft #41) | Canonical calculation artifacts (§3.8). |
| Content-addressed store with integrity checks | `packages/domain/src/twin/content-store.ts`, `@metafarm/storage` (draft #41/#42) | The evidence store (§5.3). |
| Plan-only anchors (`executable: false`) for Token-2022 metadata and Bubblegum leaves | `packages/domain/src/twin/anchor.ts` (draft #43) | Planning the anchoring of yield roots, without anchoring. |
| Unsigned intents with a TTL | `packages/domain/src/twin/intents.ts` (draft #41) | The shape for unsigned claim intents (§6). |
| J7 ownership index: finalized mint/transfer/burn events with slots, a cursor, `rebuildOwnership` | migration 0020, `packages/chain/src/twin/*` (draft #50–#52) | The snapshot and time-weighted source (§4). The cluster-verification follow-up is required first. |
| J8 player wallets (separate from party wallets); `heldByYou` | migration 0022 (draft #57) | Display only. **Never a basis for payment** (§4.3). |
| `Idempotency-Key` on tenant writes; keyset paging | drafts #54, #55 | Every yield write; every yield list. |
| Offline retry decision for expired Token-2022 attempts | draft #58 | The pattern for "did it land?" before any re-attempt of a yield payout (future). |
| Unity engine-free core: GET-only transport; reflection test forbids signing | `clients/unity-starter/Runtime/Core` (draft #40+) | Yield read models (§8). |

**What does not exist** and must be designed, or confirmed by the owner:
- no Solana program of any kind;
- no on-chain vault, escrow or claim mechanism;
- no stablecoin rail on Solana;
- no oracle or exchange-rate source;
- no bank integration;
- no investor-facing login (parties are records, not users);
- no auditor role;
- no legal structure.

Today's only payout path is the TRON `distribution` order, which is disabled under the holds.

## 1. Scope and terminology

| Term | Definition (proposed) |
| --- | --- |
| **Yield cycle** | One accounting period for one **asset** (or one pool of identical units of an asset) in which proceeds are recognised, costs and reserves are deducted, and a net amount may be allocated to holders. Has an id, a period `[start, end)`, a status (§2.1) and a formula version. |
| **Asset** | A `business_assets` row (main): the real thing, e.g. a parcel, a machine or a storage unit. Its on-chain **representation** (`asset_representations`) is what holders hold. |
| **Asset class** | The economic category that decides which lifecycle and evidence apply: land/infrastructure, equipment, crop/commodity-linked, service revenue, non-yield-bearing, simulation/test (below). |
| **Eligible holder** | An RWA **party** that, at the cycle's eligibility point, held units through one of its registered `party_wallets`, and passes the compliance gate at allocation time. A wallet address on its own is never an eligible holder. |
| **Ownership unit** | The smallest unit of the representation: a Token-2022 base unit, at the mint's `decimals`; or one compressed NFT (Bubblegum leaf) = 1 unit. |
| **Snapshot point** | The finalized Solana **slot** at which holdings are read, together with the J7 cursor proving that the index covered it. Wall-clock time is only a label, mapped to a slot by a recorded rule (§4.2). |
| **Time-weighted ownership** | Σ over intervals of (units held × slots held) within the cycle's slot range, from finalized ownership events. |
| **Gross revenue (R)** | Proceeds actually recognised for the cycle under the formula version: invoiced sales or service fees, net of refunds, chargebacks, rebates and sales taxes collected for authorities. Recognised only with evidence (§5). |
| **Operating expenses (O)** | Evidence-backed costs of producing that revenue in the period: inputs, labour, transport, storage, commissions, maintenance actually spent, bad-debt write-offs. |
| **Maintenance and capital reserve (M)** | An amount withheld for future maintenance or replacement of the asset, by policy (a percentage or a schedule). It is **not** an expense; it is retained, and may be released later (§3.5). |
| **Climate, insurance or risk reserve (I)** | An amount withheld against crop failure, weather or counterparty losses, by policy. |
| **Platform or operator fee (P)** | The operator's compensation. Its base (gross, operating result, or after reserves) is a **decision** (§3.3). |
| **Net distributable yield (NDY)** | The amount, in the settlement unit, that the cycle allocates to eligible holders after the waterfall (§3.3). It can be zero. A negative result is a **loss**, which is not allocated. |
| **Claim** | A holder's entitlement in a published cycle: one leaf, an amount, a status (§6.5). It is not money until paid. |
| **Merkle leaf** | The domain-separated hash of one canonical allocation record (§6.2). |
| **Merkle root** | The root of the cycle's allocation tree. It commits to every leaf, in canonical order. |
| **Evidence bundle** | The canonical manifest listing every evidence item of the cycle (hash, type, issuer, time), plus the items stored content-addressed (§5). |
| **Attestation** | A signed or recorded statement by an identified party (auditor, agronomist, buyer, bank) about specific evidence hashes or about the calculation artifact hash. |
| **Reconciliation** | Comparison of what the cycle says (allocations, payouts) with what happened (funds received, payouts made, claims), with a case for every difference. |
| **Correction and supersession** | A published cycle is never edited. A correction is a new cycle version with a `supersedes` link and a delta allocation; the old version becomes `superseded`. |
| **Dispute** | A formal objection to evidence, calculation or allocation, with an owner, a deadline and an outcome. It may freeze payouts for the cycle (§2.3). |

**Asset classes:**

| Class | Examples in the current model (`ASSET_KINDS`) | Yield source | Notes |
| --- | --- | --- | --- |
| Land or infrastructure | `parcel`, `building`, `storage_unit` | rent, leases, storage fees | `parcel` is a cNFT kind (`CNFT_ASSET_KINDS`) |
| Equipment and machinery | `equipment` | rental or machinery-as-a-service | revenue from hours used (meter readings, telemetry) |
| Crop or commodity-linked | `tree`, `harvest_lot`, `livestock` | sale of physical produce | price, quality, weather and logistics risk |
| Service revenue | `storage_unit`, `logistics_lot` | packaging, cold-chain, transport fees | |
| Non-yield-bearing | any asset whose policy says `yield: none` | none | cycles cannot be created |
| Simulation/test | any asset flagged `test` (new flag), or on a devnet representation | simulated only | **never** mixed with real cycles; labelled like `fixture` ownership |

`farm_share` is a share token over a pool of the above. Its class is the class of the pool's
yield source.

## 2. Business models and lifecycle

### 2.1 One state machine for every cycle

```
draft ─► inputs_locked ─► calculated ─► under_review ─► approved ─► published ─► funded* ─► distributing* ─► closed
  │            │              │               │             │            │            │              │
  └► cancelled └► draft       └► draft        └► draft      └► cancelled └► disputed ◄┴──────────────┘
                (unlock)       (recalc)      (rejected)    (before publish)   │
                                                                              ├► published (dispute dismissed)
                                                                              └► superseded (by a correction)
```
`*` means future phases only. `funded` and `distributing` require the separate on-chain or payout approval.

| From → To | Who (proposed permission) | Preconditions | Invalid when |
| --- | --- | --- | --- |
| draft → inputs_locked | preparer (`yield:prepare`) | every required evidence type for the lifecycle is registered (§5); period closed | period still open; required evidence missing |
| inputs_locked → draft | preparer | no calculation artifact published | — |
| inputs_locked → calculated | system (pure calculation) | formula version exists and is approved | input hash changed since lock |
| calculated → under_review | preparer | calculation artifact stored, hash recorded | — |
| under_review → approved | **reviewer ≠ preparer** (`yield:approve`), plus attestation quorum (§5.4) | attestations cover the evidence-bundle hash and the artifact hash; no open dispute | same person as preparer (four-eyes, as `rwa_orders_four_eyes`); quorum not met |
| under_review → draft | reviewer | rejection reason recorded | — |
| approved → published | approver | allocation tree built; root recorded; eligibility snapshot frozen | J7 not covering the snapshot slot; ownership unknown for any unit (§4.6) |
| approved → cancelled | approver | — | already published |
| published → disputed | any authorised holder or reviewer | dispute recorded (§2.3) | cycle closed |
| disputed → published | dispute authority | dispute dismissed, with reasons | — |
| published/disputed → superseded | approver, with a correction cycle that is itself approved | correction published | correction not approved |
| published → funded | **future, separate approval** | funds proven received (§6.4) | phase 1 (simulation): always invalid |
| funded → distributing → closed | future | per payout rail | phase 1: always invalid |
| any → (an earlier state) not listed | — | — | always invalid; database trigger, as for `chain_operations` |

Every transition is written to an append-only transition log, with actor, time and reason,
mirroring `chain_operation_transitions` (main).

### 2.2 Lifecycles by business model

The same columns apply to each model. The differences are shown below. **Responsible party** means
who records it; the attester is listed separately.

| Model | Required inputs | Responsible | Evidence required | Approval gates | Calculation | Publication | Funding | Claim | Reconciliation | Dispute and correction |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Crop production and physical sale** | harvest volume and grade; sale contracts; invoices; payments received; direct costs | farm operator | harvest batch record (0004), weighbridge and warehouse receipts, invoices, settlement records, cost receipts; agronomist and auditor attestations | evidence complete; quorum; four-eyes | R = paid invoice value net of refunds and sales taxes; O per receipts | root plus a public summary | future | future | invoices against payments; payouts against allocations | quality or weight dispute → correction cycle |
| **Equipment rental / MaaS** | rental contracts; hours used; rates; maintenance spent | equipment operator | meter readings (0007) and telemetry rollups (0017) for hours; invoices; payments; service records | as above, plus a usage-evidence check (meter against invoice hours) | R = billed hours × rate, paid; O includes fuel and operator time | as above | future | future | hours billed against hours metered | billing dispute |
| **Storage, packaging, cold-chain** | storage contracts; throughput; temperature logs | facility operator | warehouse receipts; IoT temperature data (spoilage liability); invoices | as above | R = fees paid; O includes energy | as above | future | future | throughput against receipts | spoilage or claim dispute |
| **Zero-yield or loss-making cycle** | as for the model | as for the model | as for the model | the same gates: a loss must be just as well evidenced | NDY = 0; loss recorded and carried per policy (§3.5) | published as **"no distribution"**, with the loss shown | none | none | — | the same |
| **Revenue received, evidence disputed** | as for the model | as for the model | as for the model, plus the dispute record | blocked at `under_review` (or `disputed` after publish) | frozen | not published, or published then `disputed` | frozen | frozen | — | dispute authority decides; outcome is dismiss or correction |
| **Partial payment** | invoices; partial settlements | as for the model | invoice plus settlement records showing the paid share | as above | **cash basis**: only received amounts count, and the remainder is a receivable carried to a later cycle (decision D-3); or **accrual** with a bad-debt policy | as above | future | future | receivable ageing | later receipt → included in a later cycle, never by reopening this one |
| **Currency conversion** | the sale currency differs from the settlement unit | as for the model | FX source record: rate, timestamp, provider; actual conversion record if converted | as above, plus FX evidence | converted at the recorded rate (§3.2); conversion costs are O | as above | future | future | realised against recorded rate → difference to the next cycle | FX dispute → correction |
| **Cancelled or superseded cycle** | — | approver | reason | the approver's decision | — | `cancelled` (before publish) or `superseded` (after) | none | old claims void, replaced by a delta (§6.6) | old against new allocations | — |

### 2.3 Disputes

- A dispute has: a subject (evidence item, calculation, or allocation leaf), a raiser, a reason, a
  deadline, an assignee, an outcome (`dismissed`, `corrected`, `withdrawn`), and links to
  evidence.
- **Freezing:** while a dispute about a cycle is open, nothing for that cycle moves to
  `funded` or `distributing` (future). Allocation views show "disputed".
- The dispute authority, and whether holders can raise disputes at all, are decisions (D-9).

## 3. Financial calculation model

### 3.1 The proposed formula, examined

`NDY_c = max(0, R_c − (O_c + M_c + I_c + P_c))` has five problems:

1. **The fee base is undefined.** If P is a percentage, of what? A fee on gross pays the
   operator even when the cycle loses money. A fee on profit aligns incentives but needs a
   precise profit definition.
2. **Reserves are treated like costs.** M and I are retained, not spent. They belong to holders
   economically until released or used, so they must be tracked as balances, not deducted and
   forgotten.
3. **`max(0, …)` erases losses.** A loss must be recorded, and either carried forward against
   future cycles or written off, by an explicit policy.
4. **Order of operations is ambiguous.** Reserves as a percentage of *what*: gross, operating
   result, or after the fee? Each choice gives different numbers.
5. **Taxes, refunds and bad debt are missing**, and so are currency effects and the rounding
   remainder.

### 3.2 Units, precision and rounding (proposed)

- **Settlement unit:** one per cycle, chosen per asset (decision D-2), e.g. a stablecoin token
  on a named network, with its `decimals`. All allocation amounts are **integers in base units**
  (as `numeric(78,0)` on main). There is no floating point anywhere in the calculation.
- **Fiat inputs:** integers in **minor units**, with the ISO 4217 exponent (e.g. 2 for EUR, 0 for
  JPY). The existing `numeric(15,2)` cost columns are read as minor units ×100 when copied into a
  cycle.
- **FX:** a rate is a rational `num/den` of integers, with source id, timestamp and a stored
  record. Conversion is `floor(amount_minor × num × 10^decimals / (den × 10^exp))` (round down:
  never create money). The truncated fraction goes to the rounding remainder.
- **Rounding:** every step rounds **down** to the settlement unit. Allocation uses the
  **largest-remainder method** with a deterministic tie-break (ascending leaf key bytes). The
  remainder that cannot be allocated (`NDY − Σ allocations`, at most one base unit per holder) is
  recorded and goes to the next cycle or a reserve (decision D-7).
- **Reproducibility:** the calculation is a pure function `(inputs, policy, formulaVersion) → artifact`
  in `packages/domain`, with no clock, I/O or randomness. The same inputs always give the same bytes
  and the same hash.

### 3.3 Proposed waterfall (provisional)

```
R_gross                         invoiced sales or fees recognised in the period (evidence-backed)
− refunds, chargebacks, rebates
− sales/VAT collected for authorities (pass-through, never revenue)
= R                             net revenue
− O                             operating expenses (evidence-backed, incl. transport, storage, commissions, bad debt written off)
= OR                            operating result (may be negative)
if OR ≤ 0:  loss L = −OR; NDY = 0; no reserves added, no profit fee; L handled by policy (§3.5)
else:
− LCF_used = min(OR, loss carried forward)          (if carry-forward policy is on)
= OR'
− M = m% × OR'                  (or a fixed schedule; capped)
− I = i% × OR'                  (capped)
− P = p% × OR'                  (fee on the result after reserves? or before? decision D-1)
+ released reserves (approved releases only)
= NDY                           ≥ 0, in settlement units after FX
```

Placing P after reserves charges the fee only on cash that actually reaches holders' side of the
ledger. Placing it before them is common in some structures. **Decision D-1** covers the fee base, the
fee cap (absolute, or a percentage of R), and any fixed minimum fee. A fixed fee on gross is
possible, but must be disclosed as payable even in loss cycles.

**Governance controls:**
- fee percentages and caps live in a **versioned policy record**, approved four-eyes, and can
  never be changed for an already-locked cycle;
- every cycle stores the policy hash it used.

### 3.4 Specific treatments

| Item | Proposed treatment | Decision? |
| --- | --- | --- |
| Refunds and chargebacks | Reduce R in the cycle where they occur; if after publication, a negative adjustment in the next cycle (never a reopen) | D-5 |
| Taxes collected (VAT/GST) | Excluded from R | [Legal] |
| Income taxes, withholding | Out of the formula; holders' tax treatment is [Legal]. Withholding, if required, is a separate deduction per holder | [Legal] D-15 |
| Transport, storage, commissions | O, with evidence | — |
| Bad debt | O when written off under policy (cash basis: never in R) | D-3 |
| Negative result | Loss L recorded; NDY = 0 | — |
| Zero result | NDY = 0; published as "no distribution" | — |
| Loss carry-forward | Off by default? On? With an expiry? | **D-6** |
| Reserve roll-over and release | Reserves accumulate per asset; release only by an approved, evidenced decision, as an input to a later cycle | **D-5** |
| Revising a cycle | Never in place. Corrections are new versions (§6.6) | — |
| Reopening after publication | Not allowed; only supersession | — |
| Overpayment | A negative delta in the correction, netted against the holder's future allocations; never clawed back on chain without a legal basis | [Legal] D-8 |
| Underpayment | A positive delta in the correction cycle | — |
| Double counting | Each evidence item (by content hash) and each source record (invoice number, receipt id) may back at most one cycle input (unique constraint, §7) | — |

### 3.5 Examples (fictional numbers; settlement unit = a USD-pegged token with 6 decimals; policy: m = 10%, i = 5%, p = 10% of OR' after reserves, carry-forward on)

**A. Positive yield (equipment rental, one month):**
- R_gross = 12,400.00 USD; refunds 400.00; R = 12,000.00.
- O = 7,000.00 → OR = 5,000.00; no carry-forward → OR' = 5,000.00.
- M = 500.00; I = 250.00; base for P = 4,250.00 → P = 425.00.
- **NDY = 3,825.00 USD = 3,825,000,000 base units.**

**B. Zero yield:** R = 6,000.00, O = 6,000.00 → OR = 0 → NDY = 0. Published as "no distribution";
nothing allocated.

**C. Loss-making cycle (crop, hail):**
- R = 2,000.00, O = 9,500.00 → OR = −7,500.00.
- L = 7,500.00 carried forward. NDY = 0.
- Next cycle OR = 10,000.00 → LCF_used = 7,500.00 → OR' = 2,500.00 → M = 250, I = 125, P = 212.50 → NDY = 1,912.50.

**D. Partial payment (cash basis):**
- Invoiced 20,000.00, received 12,000.00 → R = 12,000.00.
- The receivable of 8,000.00 is not in R; it enters a later cycle when received.
- With O = 7,000.00 this is example A's arithmetic.

**E. Multiple currencies:**
- Sale of 10,000.00 EUR (exponent 2 → 1,000,000 minor units).
- Recorded rate 1.0850 USD/EUR = 217/200, from source "X" at 2026-09-30T16:00Z.
- 1,000,000 × 217 × 10^6 / (200 × 10^2) = 10,850,000,000 base units = 10,850.00 USD.
- A conversion fee of 0.2% = 21.70 USD goes to O. The realised-vs-recorded difference goes to the next cycle.

**F. Rounding remainder:**
- NDY = 1,000,000 base units across three holders with equal weight (1/3 each).
- Exact shares are 333,333.33…. Floors are 333,333 ×3 = 999,999. Remainder 1.
- Largest remainder: all three are equal; the tie-break by ascending leaf key gives the unit to the first holder.
- Final 333,334 / 333,333 / 333,333. Recorded remainder = 0, after allocation of the one unit.
- If the policy is "never allocate remainders", the 1 unit goes to the next cycle instead (D-7).

### 3.6 Versioning and hashes

- `formula_version` is a semver-like id (e.g. `yield-formula/1`) whose implementation is a pure
  function in the domain package. A new version never changes how old cycles were calculated.
- The **calculation artifact** is canonical JSON (the `canonicalJson` already on main) containing:
  - the input record hashes;
  - the evidence-bundle hash and the policy hash;
  - every waterfall line, the FX records and the allocation table;
  - the remainder.

  Its SHA-256 is recorded and attested. Anyone can recompute it from the inputs.

### 3.7 Decisions this section depends on

D-1 fee base and cap; D-2 settlement units and mints; D-3 cash or accrual basis; D-4 reserve
percentages and caps; D-5 reserve release, and refunds after publication; D-6 loss
carry-forward; D-7 rounding remainder; D-8 overpayment netting [Legal].

## 4. Holder eligibility and allocation

### 4.1 Models compared

| Model | Fairness | Complexity | Transferability | Flash-holding resistance | Sybil / wash risk | Token-2022 | cNFT | J7 index today | Auditability | Legal / UX |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Point-in-time snapshot | low near the cutoff | low | free | **poor** (buy before, sell after) | high | yes | yes | yes: `rebuildOwnership` up to a slot | high | simple to explain; rewards timing |
| Time-weighted balance | high | medium | free | **good** | low | yes | yes (0/1 per leaf) | **yes: events carry slots**; needs a slot range per cycle | high (events are public) | "you earn for the time you held" |
| Minimum holding period | medium | low–medium | free | good | medium | yes | yes | yes | high | must be disclosed up front |
| Epoch-based | medium–high | medium | free | medium | medium | yes | yes | yes | high | understandable if epochs are fixed |
| Lock-up with transfer restrictions | high | **high** (needs Token-2022 extensions: transfer hook, non-transferable, or freeze) | **restricted** | excellent | low | yes, via extensions on a **new** mint | partly (Bubblegum delegates or freeze) | yes | high | **[Legal]**: restrictions change the product |
| Hybrid (time-weighted + minimum hold) | high | medium–high | free | excellent | low | yes | yes | yes | high | most explaining needed |

### 4.2 Recommendation (provisional, pending D-12)

1. **Phase 1 (simulation):** time-weighted over the cycle's slot range from J7's finalized events,
   with a point-in-time snapshot computed alongside for comparison. Both are pure functions of the
   stored events.
2. **Later:** add a minimum-holding threshold if flash-holding shows up in simulations.
3. **Lock-ups** only with a legal decision and a new mint design.

**Slots or time:** weighting by **slots** is chain-native and reproducible from J7 data alone. It is
unaffected by validator clocks, but slot duration varies. Weighting by **time** needs a recorded
slot→time map (block times). Decision D-12.

### 4.3 Rules

| Topic | Proposed rule |
| --- | --- |
| Eligibility cutoff | The cycle's slot range is `(start_slot, end_slot]`, both finalized. Each is fixed at `inputs_locked` from the first finalized slot at or after the period's wall-clock bounds, with the mapping evidence stored. |
| Snapshot source | The J7 ownership index (`chain_ownership_events` up to `end_slot`), and only if the asset's cursor ≥ `end_slot`. Never DAS or live RPC at calculation time. The index source must have passed the **cluster verification** (the J7 follow-up). |
| Transfers near the cutoff | Under time-weighting they matter only in proportion to the time held. Same-slot ordering follows the index (txIndex). Conflicts fail closed. |
| Several wallets of one party | Holdings are summed per **party** over its registered `party_wallets` on that network. One leaf per party per cycle, paid to the party's designated payout wallet (decision D-14). |
| Lost or inaccessible wallets | The allocation stays with the party, not the address. A re-designation of the payout wallet needs KYC re-verification, four-eyes approval and a cooling-off period [Legal] (D-14). |
| **Player wallets vs party wallets** | **Player wallets never create, imply or receive an allocation.** A holder address that is a player wallet but not a party wallet is **unattributed** (below). A player may see `heldByYou` and, if they are also a party through a separate, explicit association, their party's allocation. Two explicit records, two consents. The invariant of J8 is preserved. |
| Unattributed holders | Units held by addresses that are not a registered party wallet still count in the denominator. Their share is computed, **not paid**, and held as *unattributed* (decision D-13: held for later claim after KYC, released to a reserve after expiry, or excluded from the denominator). Excluding them silently would increase everyone else's share; that is a decision, not a default. |
| Frozen, sanctioned or blocked | The compliance gate (main) decides at allocation time. Blocked parties' shares are computed and **withheld** (not redistributed), with a case opened. Frozen token accounts (`frozen` representation status) follow the same rule. [Legal] |
| Unknown ownership | If J7 reports `not_indexed` for the asset, or the cursor is behind `end_slot`, the cycle **cannot be published**. Never treat unknown as "nobody holds". |
| Test assets | Simulation/test assets and devnet representations are allocated only in simulation cycles, labelled as such, and never mixed with real cycles. |
| Ownership changes during disputes | Allocation is fixed by the slot range, so later transfers don't change it. A correction recomputes from the same events. |
| Fractional units | Weights are integers (units × slots); shares are exact rationals until the final floor. |
| Dust | Allocations below a threshold (D-7) are not paid, but accumulated per party for a later cycle, or released to the remainder by policy. |
| Rounding and residual | §3.2: largest remainder, deterministic, with the remainder recorded. |

## 5. Evidence and attestation model

### 5.1 Separation

| Layer | What | Where (proposed) |
| --- | --- | --- |
| Evidence storage | The original file bytes | the content-addressed store (`@metafarm/storage`, draft #41/#42), private bucket |
| Evidence metadata | Type, issuer, fields, timestamps, classification | `yield_evidence` rows (§7) |
| Evidence hash | SHA-256 of the exact bytes | metadata row, plus a `data_commitments` row (draft #40; subject type `record`, or a new `evidence` type) |
| Attestation | Who vouches for which hashes | `yield_attestations` |
| On-chain anchor | The root of an evidence batch or of the allocation tree | **plan only** (`planAnchor`, draft #43) until a separate approval |

The **evidence bundle manifest** is canonical JSON `{scheme:"metafarm-yield-evidence/1", cycleId,
items:[{type, contentSha256, issuer, sourceId, issuedAt, tz, …}] sorted by (type, contentSha256)}`.
Its hash is what attestations and the calculation artifact reference.

### 5.2 Evidence types

Common fields for every type:
- `contentSha256` (of the exact bytes);
- `byteSize`, `mediaType`;
- `issuedAt` (an instant, RFC 3339 with offset), plus `timeZone` (IANA) for local-date documents;
- `sourceId` (the issuer's document number);
- `recordedBy`, `recordedAt`;
- `classification`;
- `supersedes` (for corrections).

Corrections are a new item that `supersedes` the old one, which is never deleted. Revocation is an
attestation of revocation.

| Type | Issuer | Required fields (beyond common) | Format | Signature / attestation | Retention (proposed, [Legal]) | Classification |
| --- | --- | --- | --- | --- | --- | --- |
| Weighbridge receipt | weighbridge operator | gross/tare/net weight + unit, vehicle id, crop, lot | PDF/image + structured JSON | operator signature or stamp; scanned | 10 y | confidential (commercial) |
| Warehouse receipt | warehouse | lot, quantity, grade, storage period | PDF + JSON | warehouse-issued; may be a negotiable document [Legal] | 10 y | confidential |
| Sales invoice | seller (operator) | buyer (pseudonymised id), lines, currency, totals, taxes, due date | PDF/XML (e-invoice formats where they exist) | issuer's e-invoice signature where available | per tax law [Legal] | confidential; contains PII if the buyer is a person |
| Export and customs records | customs broker or authority | declaration number, HS code, quantities, values | PDF/XML | authority reference | per law | confidential |
| Bank or settlement record | bank | account (masked), amount, currency, value date, reference | statement extract (CSV/PDF), or an API record | bank-provided; auditor-confirmed | per law | **restricted** (financial PII) |
| Stablecoin settlement record | chain | network, tx signature or hash, token, amount, from/to | JSON of the finalized transaction | **verified from the chain** at finality (the read-only RPC pattern of J7) | 10 y | confidential |
| Equipment telemetry | device or platform | device id, window, hours, readings | rollup JSON (0017) | device identity (MQTT TLS client certificate) plus a platform commitment | 3–10 y | internal |
| IoT data (e.g. temperature) | device | sensor, window, series hash | JSON | as above | 3 y | internal |
| Weather data | provider | station or grid, window, variables, provider version | JSON | provider reference; licence terms | 3 y | internal; licence-restricted |
| Auditor or expert attestation | auditor or agronomist | scope, items covered (hashes), opinion, date | signed PDF + JSON | an identified person's signature (method in D-10) | 10 y | confidential |

**Personal and commercial data:**
- buyer identities, bank details and prices stay in the private store, never in public endpoints;
- public summaries carry hashes and totals only;
- fields are minimised and pseudonymised where possible [Legal: data protection].

### 5.3 Storage options (D-11)

| Option | Availability | Privacy | Pinning / durability | Retention control | Cost | Legal risk |
| --- | --- | --- | --- | --- | --- | --- |
| Private object storage (S3-compatible; already abstracted) | provider SLA | **private by default** | provider durability; versioning and object lock possible | **full** (deletion possible: data-protection rights) | low | low; the data controller keeps control |
| IPFS (with a pinning service) | depends on pinning | **public content** if the CID is known | needs paid pinning | weak (copies can persist) | low–medium | **high for PII or commercial data**: erasure is impractical |
| Arweave | permanent | public | permanent by design | **none** | one-off fee | **high**: erasure impossible |
| A hybrid: private store for bytes, public store for hashes and manifests | good | good | good | good | low | low |

**Recommendation (provisional):** keep the bytes in private object storage with object lock or
versioning, and keep only hashes, manifests and roots in public endpoints or on chain later. IPFS or
Arweave only ever for data that is meant to be public and contains no PII.

### 5.4 Attestations

An attestation is `{attester (identified), role, statement type, subject hashes, issuedAt, method,
signature or reference}`.

**Methods (D-10):**
- **recorded** (an authenticated platform user with the attester role clicks "attest"; audited);
- **document signature** (a signed PDF whose hash is stored);
- **key signature** (an Ed25519 or ECDSA signature over a domain-separated message, *verified*,
  never produced, by the platform).

**Quorum (D-10):** e.g. one independent auditor plus one operator manager, for publication. It is
configurable per asset class.

## 6. Merkle distribution and claim architecture

### 6.1 Pipeline (phase 1 = steps 1–10, and 12–13 as read-only simulation)

1. Receive cycle inputs: records referencing evidence hashes.
2. Validate: required evidence types per lifecycle (§2.2); hashes present in the store; no source
   record already used (§3.4).
3. Calculate: pure function → artifact (§3.6).
4. Allocate: pure function over J7 events in `(start_slot, end_slot]` → weights per party; the
   unattributed and withheld shares are recorded (§4.3).
5. Payout records: `{party, payout wallet, amount}`, deterministic order.
6. Canonical leaves (§6.2).
7. Merkle tree (RFC 9162 construction, as on draft #40).
8. Store the artifact, the manifest and the tree in the content store; record the hashes.
9. Publish a reviewable draft (internal).
10. Approve (four-eyes plus quorum) → `published` (internal publication of root and summary).
11. **Fund: future, separate approval.**
12. Serve proofs: read-only.
13. Reconcile: in phase 1, simulated payouts against allocations.
14. Close or supersede.

### 6.2 Canonical leaf (proposal: binary, fixed layout, for on-chain verifiability later)

Hash: `leaf = SHA-256(0x00 ‖ SHA-256(leaf_bytes))`. That is RFC 9162 leaf hashing over the digest of
the record, as `merkleLeaf` does on draft #40. Interior nodes are `SHA-256(0x01 ‖ l ‖ r)`. Solana
programs can verify SHA-256 with a syscall, so the same tree works off-chain and on-chain (D-17).

`leaf_bytes`, little-endian, with every field fixed-size:

| Field | Bytes | Notes |
| --- | --- | --- |
| domain tag | 32 | `SHA-256("metafarm-yield-leaf/1")`. Domain separation from every other tree. |
| network id | 1 | 1 = solana-devnet, 2 = solana-mainnet, … (a registry constant). Prevents cross-cluster replay. |
| cluster genesis hash | 32 | binds the leaf to the verified cluster (the J7 follow-up) |
| cycle id | 16 | UUID bytes |
| cycle version | 4 | u32; corrections increment it |
| epoch | 4 | u32 (0 when unused) |
| asset representation id | 32 | Token-2022 mint, or for cNFT pools the pool's identifier (a 32-byte hash) |
| recipient | 32 | the party's payout address (Solana pubkey). TRON payout needs a different leaf variant (21-byte address), and stays out of scope under the hold. |
| payout mint | 32 | the settlement token mint |
| amount | 16 | u128 in base units |
| formula version | 2 | u16 |
| tree version | 2 | u16 (the leaf-layout version) |
| leaf index | 4 | u32, the position in canonical order |

- **Canonical order:** by `recipient` bytes ascending. Duplicates are impossible because the
  allocation is per party → one recipient per party per cycle (a unique constraint on `(cycle,
  version, recipient)`).
- **Replay protection:** the domain tag, network, genesis hash, cycle id and version make a leaf valid
  only for one tree. A future claim program would also record claimed indices per root (a bitmap).

### 6.3 Stages distinguished

| Stage | What it means | Phase 1 |
| --- | --- | --- |
| Off-chain calculation | the pure artifact | yes |
| Off-chain publication | the root and summary visible to authorised users | yes (internal) |
| On-chain root anchoring | the root written on chain (memo, Token-2022 metadata or a program account) | **plan only** (`executable: false`) |
| On-chain vault funding | settlement tokens moved into an escrow the claim program controls | **no**. Needs a program that does not exist |
| On-chain claim | a holder proves a leaf and receives funds | **no**. Needs a program that does not exist |
| Off-chain payout | platform-pushed transfers (e.g. the existing `distribution` orders on TRON) | **no** (RWA and TRON holds) |
| Manual reconciliation | cases for every mismatch | yes (simulated) |

**Future boundary:** a Solana claim program would need:
- a vault per cycle (an associated token account owned by a PDA);
- a root per cycle and version;
- a claimed-bitmap;
- a `claim(leaf, proof)` instruction that checks the domain tag, the network, the root and the bit;
- an admin path to supersede or close a root, with timelock and multisig.

It has to be designed, audited and approved separately (D-16).

### 6.4 Push or pull (D-16)

- **Push** (the existing model on main): the platform creates one `distribution` order per party,
  each with four-eyes approval and a TRON settlement intent. It's simpler for holders, but means
  platform-initiated transfers, custody and AML exposure, and the TRON hold.
- **Pull** (a Merkle claim): holders claim from a funded vault. It needs a program, an audit,
  wallet UX and fee payment by the holder.

In both cases, the Merkle root is the audit commitment.

### 6.5 Claims

- **Status:** `pending` (published, not yet claimable) → `claimable` → `claim_intent_created` →
  `submitted` (future) → `claimed` | `failed` | `expired` | `voided` (superseded) | `withheld`
  (compliance).
- **Idempotency:** a claim intent is keyed by `(cycle, version, leaf index)`. Repeating it returns
  the same unsigned intent (the pattern of draft #41: TTL, no signing).
- **Partial failure:** a submitted claim that has not been observed is never re-sent (the
  `outcomeUnknown` rule on main). It is re-checked like draft #58's decision.
- **Expiry and unclaimed funds:** a claim window per cycle (D-18). Unclaimed amounts go back to a
  reserve or the next cycle by policy [Legal: unclaimed property rules].
- **Double claim:** prevented by the claimed-bitmap (future on chain), and off-chain by the unique
  leaf per recipient plus a status machine.
- **Fees:** in pull, the holder pays network fees unless the platform sponsors them (D-18).
- **Failed transactions:** handled as in the existing operation lifecycle (main).
- **Finality:** everything is read at `finalized`. A reorg before finality is not counted.
- **Devnet and mainnet:** different network ids and genesis hashes in the leaf. Mainnet stays locked
  (`RWA_MAINNET_ENABLED`).

### 6.6 Corrections and supersession

- A correction is cycle version *n+1*, with the same id, a new root and `supersedes = n`.
- Holders who were already paid under version *n* get **delta** leaves: positive, or zero with a
  recorded negative to net later (D-8).
- In a pull model, version *n*'s root is closed in the program (future).
- Off-chain, version *n*'s unclaimed claims become `voided`.

**Phase 1 produces only:**
- the calculation artifact;
- the evidence manifest;
- the tree;
- proofs;
- **unsigned** claim intents;
- simulated reconciliation reports.

It signs, submits, funds and claims nothing.

## 7. Database and API plan

Convention: plain SQL migrations, RLS by `tenant_id` with `FORCE ROW LEVEL SECURITY`, the
`metafarm_app` role, typed repositories, zod schemas, OpenAPI 3.1. **No migration is written yet.**

### 7.1 Reuse first

- `data_commitments` and `commitment_batches` (draft #40) hold the hashes of evidence and of
  artifacts, and batch them for later anchoring. Add a subject type `evidence` (a widening
  CHECK, like 0019).
- `audit_events` (main, append-only) for *who did what*. The yield tables need their own
  **append-only fact tables**, but no separate `yield_audit_events`: one audit log, with yield
  actions (`yield.cycle.approved`, …), avoids two sources of truth. A table-specific transition log
  holds state changes.
- `reconciliation_cases` (main) is keyed to `rwa_orders` by foreign key. Payout-level cases can use
  it once payouts are distribution orders. Yield-level differences need `yield_reconciliations`.
- `idempotency_records` (draft #54) covers every write. Keyset paging (draft #55) covers every list.
- `parties`, `party_wallets` and the compliance gate (main) handle eligibility.

### 7.2 Proposed tables (names shortened to `yield_*`; all tenant-scoped with RLS unless noted)

| Table | PK | FKs | Unique | Status / versions | Money | Hashes | Append-only? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `yield_cycles` (the brief's `yield_distributions`) | id uuid | tenant; asset (`business_assets`); representation; supersedes → self | (tenant, asset, period, version) | status (§2.1), `version` int, `formula_version`, `policy_hash` | settlement mint + decimals | `inputs_hash`, `artifact_hash`, `evidence_bundle_hash`, `root` | **no** (status moves), but locked columns are immutable by trigger after `inputs_locked` | slot range; `simulation` bool |
| `yield_cycle_transitions` | bigserial | cycle | — | from/to, actor, reason | — | — | **yes** | mirrors `chain_operation_transitions` |
| `yield_inputs` | id | cycle; evidence | (cycle, kind, source_ref): no double counting; and (tenant, source_kind, source_ref) across live cycles | — | `amount_minor numeric(78,0)`, `currency` (ISO) or mint | `content_sha256` | **yes** (corrections supersede) | kinds: revenue, refund, tax_collected, receivable, … |
| `yield_expenses` | id | cycle; evidence | (tenant, source_kind, source_ref) | — | as above | sha | **yes** | could be merged into `yield_inputs` with a `side` column (reviewer's choice) |
| `yield_reserves` | id | asset; cycle | — | movement kind: add, release, use | base units | — | **yes** (a ledger) | the balance per asset is a view |
| `yield_policies` | id | tenant; asset class | (tenant, name, version) | approved_by ≠ created_by | percentages as integer basis points; caps in base units | `policy_hash` | **yes** | versioned |
| `yield_evidence` | id | cycle | (tenant, content_sha256, type) | `supersedes` | — | `content_sha256`, `storage_ref` | **yes** | classification; retention class |
| `yield_attestations` | id | cycle; attester user | (cycle, attester, statement, subject_hash) | revoked_by → self | — | subject hashes, signature | **yes** | |
| `yield_fx_rates` | id | — | (source, pair, at) | — | `num`, `den` numeric(78,0) | record hash | **yes** | |
| `yield_ownership_snapshots` | id | cycle | (cycle, version) | — | — | `events_hash` (of the J7 events used), cursor slot | **yes** | references, not copies, of J7 events, plus their hash |
| `yield_allocations` | id | cycle; party | (cycle, version, party) | kind: paid, unattributed, withheld, dust | base units, weight numerator and denominator | — | **yes** | |
| `yield_merkle_trees` | id | cycle | (cycle, version) | tree_version | total base units | root, leaf count | **yes** | |
| `yield_merkle_leaves` | (tree, index) | tree; allocation | (tree, recipient) | — | base units | leaf hash, leaf bytes (hex) | **yes** | |
| `yield_claims` | id | leaf | (leaf) | §6.5 status; idempotency key | — | intent hash | no (status moves), plus a transition log | phase 1: intents only |
| `yield_reconciliations` | id | cycle | — | open/investigating/resolved/written_off (as on main) | expected/observed | — | resolution rows append-only | |
| `yield_disputes` | id | cycle; subject | — | open/resolved, outcome | — | subject hash | events append-only | |
| `yield_corrections` | id | from cycle version → to version | (cycle, to_version) | — | deltas | — | **yes** | |

All timestamps are `timestamptz` (UTC), and the IANA zone is stored where local dates matter.
Indexes go on `(tenant_id, status, created_at)` and on every foreign key. Retention follows §5.2.

**Access:** the app role gets SELECT/INSERT on fact tables and UPDATE only on status columns, guarded
by transition triggers. Public views expose only roots and summaries (§7.4).

### 7.3 API (proposed; all under `/v1/tenants/{tenantId}/yield`, `Idempotency-Key` on writes, keyset paging on lists)

| Endpoint | Purpose | Authorization (proposed new permissions) |
| --- | --- | --- |
| `POST /cycles` | create a draft | `yield:prepare` (operator) |
| `POST /cycles/{id}/evidence` | register evidence metadata (bytes go to the store via the existing upload flow) | `yield:prepare` |
| `POST /cycles/{id}/inputs` | add revenue or expense lines | `yield:prepare` |
| `POST /cycles/{id}/lock` | → inputs_locked | `yield:prepare` |
| `POST /cycles/{id}/attestations` | attest to hashes | `yield:attest` (auditor or agronomist) |
| `POST /cycles/{id}/preview` | calculate (pure; no state change) | `yield:prepare`, `yield:review` |
| `POST /cycles/{id}/review` | → under_review | `yield:prepare` |
| `POST /cycles/{id}/approve` | → approved (four-eyes) | `yield:approve` (≠ preparer) |
| `POST /cycles/{id}/publish` | → published (root) | `yield:approve` |
| `GET /cycles`, `GET /cycles/{id}` | read | `yield:read` |
| `GET /cycles/{id}/allocations?party=` | allocations | `yield:read`; holder-facing variant below |
| `GET /cycles/{id}/proofs/{leafIndex}` | Merkle proof | `yield:read`; holder variant |
| `POST /cycles/{id}/claims/{leafIndex}/intent` | **unsigned** claim intent | holder variant only; phase 1 returns a simulation-labelled intent |
| `POST /claims/{id}/status` | record observed status (system or worker only) | system |
| `POST /cycles/{id}/disputes` | open a dispute | `yield:review`, or holder variant (D-9) |
| `POST /cycles/{id}/corrections` | create a correction version | `yield:approve` |
| `GET /cycles/{id}/audit` | the complete trail (transitions + audit events + hashes) | `audit:read` or `yield:review` |

**Role mapping** (existing roles on main: owner, admin, manager, verifier, worker, viewer; D-19):

| Brief role | Proposal |
| --- | --- |
| Admin | owner or admin: everything except attesting their own preparation |
| Operator | manager + `yield:prepare` |
| Auditor | **a new role** (or the existing `verifier` extended) with `yield:read`, `yield:attest`, `yield:review`, `audit:read`, but no `prepare` and no `approve` |
| Asset manager | admin + `yield:approve` |
| Player | `/v1/me/...` only: **no** allocation by player identity. Sees `heldByYou` and public summaries |
| Linked (player) wallet | display only; never a payout identity |
| RWA party wallet | **Parties cannot log in today.** Holder-facing allocation and proof endpoints need an explicit, consented user↔party association (D-20). Until then, holders get statements through operators |
| Public | `GET /public/yield/{cycleId}`: status, period, totals (R, O, M, I, P, NDY), root, formula version, evidence-bundle hash. **No** per-holder amounts, no evidence bytes, no counterparties (D-21) |

## 8. Unity and web experience

**Read models** (engine-free core; GET only; netstandard2.1; no signing types — the reflection test
on draft #40 extends to them):
- `YieldCycleSummary`: status, period, formula version, totals with currency, `lastUpdated`,
  dispute/correction flags, `isSimulation`;
- `YieldVerification`: evidence-bundle hash, root, artifact hash, attestation count against quorum,
  and a locally re-checked proof status (reusing `Rfc9162CommitmentVerifier`);
- `YieldAllocationView`: amount, claimable, `heldByYou` semantics.

**`heldByYou` and "your allocation":**
- `heldByYou` keeps the J8 rule: true only from chain readings; absent for unknown ownership, test
  data or no linked wallet; never false-for-unknown.
- **"Your allocation" is separate.** It is shown only through the party association (D-20), never
  inferred from a player wallet.

**UI states:**

| State | Meaning shown |
| --- | --- |
| Draft | "Being prepared: figures may change" |
| Under review | "Awaiting independent review" |
| Approved | "Approved; not yet published" |
| Published | "Published: verification details available" |
| Claimable | future |
| Claimed | future |
| Partially claimed | future |
| Disputed | "Disputed: payouts paused" |
| Superseded | "Replaced by version n+1" (with a link) |
| No yield | "No distribution this period", with the reason |
| Loss-making cycle | "Loss this period", with the amount and the carry-forward effect |
| Verification unavailable | shown as such, never as verified |
| Ownership unavailable | "Ownership not indexed": never "you hold nothing" |

**Disclosures:** every yield view links to the risk disclosure [Legal]. It shows gross, costs,
reserves, fee and NDY separately, uses past tense for figures, and makes no projections. The 3D or
metaverse presentation (e.g. a glowing field) must not stand in for these figures, and must not use
reward or game vocabulary for financial amounts.

**Web:** read-only pages first (cycle list, cycle detail, evidence summary by hash, verification),
reusing the `/rwa` patterns (draft #39 on main, paging on draft #55).

## 9. Security, compliance and operational controls

### 9.1 Invariants (proposed, to be tested)

1. No key material is stored; no signing in the backend; no submission in phases 1–12.
2. The Unity core stays read-only (the reflection test).
3. Player wallets and party wallets stay separate. No allocation is ever derived from a player
   wallet.
4. Signature **verification** only (attestations, wallet proofs); never transaction signing.
5. Domain-separated messages and leaves (`metafarm-yield-*`).
6. Replay protection: network, genesis hash, cycle and version in every leaf; single-use intents.
7. Idempotent writes (`Idempotency-Key`), with unique constraints as the backstop.
8. Four-eyes for approve and publish; preparer ≠ approver ≠ attester, enforced in the database.
9. Evidence is immutable; corrections supersede; nothing is deleted except by retention policy.
10. Audit-log integrity: `audit_events` is append-only; periodic hash-chaining of exports (D-22).
11. No double allocation: one leaf per recipient per cycle version; sources are unique across cycles.
12. No double claim: the bitmap (future), plus off-chain status uniqueness.
13. Cluster verification for every chain read (closes the J7 follow-up).
14. Secret redaction (existing logger); no credential-bearing URLs.
15. PII and commercial data only in the private store; public views carry totals and hashes.
16. Rate limits (draft #53) on holder endpoints; abuse and Sybil handling via party KYC (wallets
    alone never count).
17. Disaster recovery: the artifacts are reproducible from stored inputs plus the J7 events. Backups
    cover the yield tables and the store, and restore tests verify the hashes.

### 9.2 Compliance workstream ([Legal] throughout; no conclusions here)

| Area | Questions for counsel |
| --- | --- |
| Securities or investment product | Are share tokens with yield an investment contract, collective investment scheme or similar in each target jurisdiction? |
| Commodities and warehouse receipts | Are warehouse receipts used as evidence also documents of title? |
| Payments and e-money | Does pushing or holding stablecoin for holders require a licence? |
| AML/KYC and sanctions | The existing screening gate; is travel-rule data needed? |
| Custody and wallets | Do vaults or escrow make the operator a custodian? |
| Tax reporting | Withholding; holder statements |
| Consumer disclosures | Risk warnings; no guarantees |
| Cross-border settlement | Currency controls |
| Data protection | Evidence PII; retention against erasure |
| Advertising and yield claims | Wording on the web and in Unity |

## 10. Testing strategy (designed before implementation)

| Test | Fixtures | Invariant | CI without external services? |
| --- | --- | --- | --- |
| Pure calculation | examples A–F (§3.5) as named fixtures | exact base units; NDY ≥ 0; loss recorded | yes |
| Formula versions | the same inputs under v1 and v2 | old artifacts unchanged | yes |
| Decimal and rounding | exponents 0/2/3; decimals 0/6/9; huge values (78 digits) | floor everywhere; Σ allocations + remainder = NDY | yes |
| Currency conversion | rational rates; inverse pairs | deterministic; no floats | yes |
| Evidence hash | known bytes → known hash | the manifest hash is stable under item order | yes |
| Canonical serialization | key order, unicode, numbers as strings | byte-identical | yes |
| Merkle leaf determinism | the §6.2 layout vectors | the same leaf bytes in TS and C# | yes (TS + C# job) |
| Proof verification | trees of 1, 2, 3, 2^n, 2^n+1 leaves | RFC 9162 behaviour, as on draft #40 | yes |
| Duplicate prevention | the same source twice; the same recipient twice | rejected by function and by constraint | yes; DB in the integration job |
| Snapshot / time-weighted | J7 event fixtures | the weights match a hand-computed table | yes |
| Transfer at cutoff | events at `end_slot` and `end_slot+1` | included / excluded | yes |
| Multiple wallets | a party with 3 wallets | one leaf, summed weight | yes |
| Unknown ownership | cursor behind; conflicts | publication refused | yes |
| Unattributed and withheld | a holder without a party; a blocked party | the share is recorded, not paid, not redistributed | yes |
| Disputes and corrections | version n → n+1 deltas | no edits in place; deltas sum correctly | yes (DB) |
| Idempotency | repeated writes with the same key | one effect | yes (DB) |
| Authorization | each role × endpoint | four-eyes enforced | yes (DB) |
| API contract | OpenAPI ↔ routes | routes test (existing) | yes |
| DB constraints | append-only triggers; uniques | updates and deletes refused | yes (integration job) |
| Unity core read-only | reflection | GET only; no signing types | yes (C# job) |
| Browser | read-only pages; disclosure present; no "guaranteed" wording | axe clean | yes (Playwright job) |
| Devnet integration | real mint plus J7 | snapshot from a live index | **no**: after the holds lift |
| Unity Editor and IL2CPP | read models in scenes | — | **no**: Unity 6 machine |

## 11. Delivery roadmap

**Where the work goes:**
- **as a separate feature stack**, not appended to #40–#59. The readiness document (`readiness.md`)
  freezes that stack's merge order and blast radius, and adding yield PRs would reopen both;
- **based on `feature/retire-evm-wallet-link` (#59)**, because it depends on J7 (#50–#52), J8 (#57),
  idempotency (#54), paging (#55) and the twin primitives (#40–#43);
- **retargeted to `main`** once #40–#59 are merged.

Y1–Y3 depend only on main's domain package, and could even go straight to `main` if the owner
prefers.

| PR | Scope | Depends on | DB | API | Unity | Security impact | Migration risk | Tests | Acceptance | Rollback | Railway | Devnet | Unity 6 | Legal | Runs with execution off |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Y1 | Vocabulary, state machine, invariants (domain types and docs) | — | — | — | — | none | — | transition tables | invalid transitions rejected | revert | no | no | no | review of terms | yes |
| Y2 | Calculation library (waterfall, FX, rounding, artifact hash) | Y1 | — | — | — | none | — | §10 calc rows | examples A–F exact | revert | no | no | no | policy decisions D-1…D-8 before *use* | yes |
| Y3 | Evidence and attestation model (manifest, types, verification of attestation signatures) | Y1 | — | — | — | verify-only crypto | — | hash vectors | manifest reproducible | revert | no | no | no | retention classes [Legal] | yes |
| Y4 | Content-addressed evidence storage wiring (private bucket abstraction) | Y3, draft #42 | — | — | — | private data | — | store integrity | bytes ↔ hash | revert | no (config only later) | no | no | data protection | yes |
| Y5 | Allocation from J7 events (snapshot + time-weighted; party mapping; unattributed/withheld) | Y2, #52, J7 cluster-check follow-up | — | — | — | — | — | §10 ownership rows | weights match fixtures | revert | no | no | no | D-12, D-13 | yes |
| Y6 | Merkle leaves and proofs (TS + C# vectors) | Y5 | — | — | C# verifier (read-only) | — | — | leaf/proof vectors | TS = C# | revert | no | no | no | — | yes |
| Y7 | Schema (§7.2) + append-only triggers + RLS | Y1–Y6 | **additive migration** | — | — | RLS | low (new tables only) | constraint tests | triggers refuse edits | down migration (blocked when deployed) | no | no | no | — | yes |
| Y8 | Read-only API + public summary | Y7, #54, #55 | — | **new GETs** | — | authZ | — | contract + authZ | no PII publicly | revert | no | no | no | D-21 | yes |
| Y9 | Preparer/reviewer write API (draft → published) with four-eyes | Y8 | — | new POSTs | — | four-eyes | — | idempotency + authZ | cannot self-approve | revert | no | no | no | D-9, D-10 | yes |
| Y10 | Web read-only pages + disclosures | Y8 | — | — | — | wording | — | Playwright + axe | no guarantee wording | revert | no | no | no | disclosure text | yes |
| Y11 | Unity read models | Y8 | — | — | read-only DTOs | read-only | — | C# + reflection | GET only | revert | no | no | **yes** (validation) | — | yes |
| Y12 | Unsigned claim intents | Y6, Y9 | — | POST intent (simulation) | — | no signing | — | intent determinism | marked simulation | revert | no | no | no | D-16 | yes |
| Y13 | Simulation and reconciliation tools | Y9, Y12 | — | — | — | — | — | end-to-end simulation | reports reconcile | revert | no | no | no | — | yes |
| Y14 | Devnet-only verification (snapshot from a live index) | Y13; the deploy hold lifted | — | — | — | cluster check | — | runbook | matches the explorer | disable flags | **yes** | **yes** | no | — | yes |
| Y15 | Solana claim program / on-chain anchoring | separate approval | — | — | — | **high** | — | program audit | — | — | yes | yes | no | **yes** | no |
| Y16 | Live claim and settlement | legal, security, ops and deploy approval | — | — | — | **high** | — | — | — | — | yes | yes | no | **yes** | no |

## 12. Decision register

Gate key: **Impl** = required before implementation; **Dev** = before devnet; **Prod** = before
production. Approval key: **L** = legal/compliance; **T** = technical; **P** = product.

| # | Decision | Gate | Approval |
| --- | --- | --- | --- |
| D-1 | Fee base (gross / operating result / after reserves), fee percentage, cap, minimum | Impl (for Y2 policy defaults) | P, L |
| D-2 | Settlement currencies and supported mints/networks | Dev | P, T, L |
| D-3 | Cash or accrual basis; receivables and bad debt | Impl | P, L |
| D-4 | Reserve percentages and caps (M, I) | Impl | P |
| D-5 | Reserve roll-over and release; refunds after publication | Impl | P, L |
| D-6 | Loss carry-forward (on/off, expiry) | Impl | P, L |
| D-7 | Rounding remainder and dust threshold | Impl | P, T |
| D-8 | Correction and supersession policy; overpayment netting or recovery | Impl | P, L |
| D-9 | Dispute authority; who may raise disputes; deadlines | Dev | P, L |
| D-10 | Attestation methods and quorum per asset class | Dev | P, T, L |
| D-11 | Evidence storage choice and retention | Dev | T, L |
| D-12 | Holding model (snapshot / time-weighted / minimum hold / hybrid); slots or time | Impl | P, T, L |
| D-13 | Unattributed holders: hold, release or exclude | Impl | P, L |
| D-14 | Payout-wallet designation, lost wallets, recovery | Dev | P, L |
| D-15 | Legal classification per jurisdiction; tax withholding | Prod (and before any public launch) | L |
| D-16 | Push (distribution orders) or pull (claim program); program design | Dev (for design), Prod (for use) | T, L, P |
| D-17 | Hash function for the claim tree (SHA-256 as proposed, or Keccak) | Impl | T |
| D-18 | Claim expiry, unclaimed funds, fee sponsorship | Dev | P, L |
| D-19 | Roles: a new auditor role, or extend `verifier`; new `yield:*` permissions | Impl | T, P |
| D-20 | Investor identity: how a party gets a login (user↔party association with consent) | Dev | P, L |
| D-21 | What is public (totals, root) and what is not | Impl | P, L |
| D-22 | Audit-log hash-chaining and export | Prod | T |
| D-23 | Oracle and FX sources | Dev | T, L |
| D-24 | Geographic availability | Prod | L |
| D-25 | Auto-compounding allowed? (proposal: no) | Prod | P, L |
| D-26 | Governance or reputation tokens at all? (proposal: none) | Prod | P, L |
| D-27 | Any platform token? (proposal: none) | Prod | P, L |
| D-28 | Initial release limited to one asset class? (proposal: yes; equipment rental, whose usage evidence is strongest today) | Impl | P |
