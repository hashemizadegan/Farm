# Decision brief: D-12, holding model (slots or elapsed time)

**Status: OPEN — FOR REVIEW ONLY (NO APPROVALS).** Prepared 2026-10-22 against plan revision 4 (`f914af4`).

**Sources:**
- §12 register, D-12: "Holding model; slots or elapsed time". Options in §4.1. Provisional: time-weighted by
  slots. Signers P, T, L.
- Gates: **Build** (slots or time, which sets Y5's scope); **Real** (model selection). Effect while open: Y5 scope
  undefined; real allocation refused.
- §4.1 (model comparison), §4.2 (provisional recommendation), §4.3 (rules), §13.2 item 3.

## Owner decision (recorded 2026-10-22)

The owner approved **slot-weighted holdings for Y5** (this brief's Option A, Build gate), with these conditions:
integer slot counts from the ownership index; deterministic and integer-only; **not** the final real-cycle
allocation policy (the D-12 Real gate, P, T, L, stays open); a **new weighted input type**, not the #75 64-bit share
type; explicit overflow bounds; tests for large slot counts, zero values, overflow and malformed inputs.

Implemented in #86 (`packages/domain/src/twin/holding-weights.ts`): window `(start, end]` of at most 2^32 slots,
total weight at most 2^128 − 1 (`weight_out_of_range`), `WeightedOwnershipInput` (`metafarm-weighted-ownership/1`)
with a SHA-256 commitment. The status line above is left as written, as the record of what was proposed.

## Problem

Y5 turns verified ownership events into allocation weights for one asset per cycle. The plan requires D-12 to
fix **slots vs elapsed time before Y5 is scoped** (§4.2), because the two give different results. Slot duration
varies, so a holder through slow slots holds for more real time per slot. Elapsed time also needs block times,
which the J7 index does not store. The model choice itself (snapshot, time-weighted, and so on) is the separate
**Real** gate.

Two things need deciding:
1. **Build:** slots or elapsed time. This unblocks writing Y5.
2. **Real:** the model. It can follow later; non-simulation cycles stay refused until it is approved.

## Options (from §4.1; the "Build" choice in brackets)

| | A. Time-weighted by slots, point-in-time alongside for comparison (provisional) | B. Time-weighted by elapsed time | C. Point-in-time snapshot only |
| --- | --- | --- | --- |
| Weight | Σ units × slots held within `(start_slot, end_slot]` | Σ units × seconds held (block times) | units held at `end_slot` |
| Data needed | events with slots: **already in J7** | events plus **block times** (not stored; extra build scope and an external dependency on per-slot times) | events up to a slot: already in J7 |
| Fairness (§4.1) | high; "earned for time held" | high; matches wall-clock intuition | low near the cutoff; rewards timing; poor against flash-holding |
| Determinism and audit | integers only; reproducible from the index | depends on recorded block times (an extra evidence item) | simplest |
| Build scope for Y5 | medium | medium + block-time ingestion and storage | low |

The other §4.1 models (minimum holding period, epoch-based, lock-up, hybrid) need extra product or legal
design (lock-up "changes the product" [Legal]). They are not proposed for phase 1.

## Recommendation

**For the Build gate: Option A, slots.**
- It is the plan's provisional recommendation (§4.2).
- It needs no new data source: J7 events carry slots, and Y0 now binds them to a verified cluster.
- It is fully integer and reproducible from the index, and resists flash-holding.
- Y5 would compute the slot-weighted model and, alongside it, the point-in-time view for comparison in
  simulation, as §4.2 describes.
- Elapsed time (B) could be added later only with a block-time source, which would be a separate scope.

**The Real gate stays open:** model selection, signed by P, T and L. Until then Y5 runs simulation cycles only,
and real allocation is refused, as the register states.

## What approving the Build gate unblocks (with D-17)

**Y5** (§11.1), on the J7 line after Y0 (#85):
- weights from verified RPC events in `(start_slot, end_slot]`, finalized;
- the snapshot-completeness rule: the asset's verified cursor ≥ `end_slot`; not indexed, a conflict, an
  unverified cluster or fixture data block a non-simulation `calculate` (§4.3);
- holdings summed per party over registered `party_wallets`;
- unattributed and withheld amounts recorded, never redistributed;
- fixture data refused in non-simulation cycles (D-17).

**Implementation note.** The yield pipeline's ownership snapshot (#75, `ownership-snapshot.ts`) caps each
holding at u64 (`rawShares`). Slot-weighted weights (units × slots) can exceed u64; the plan says weights use
arbitrary precision and only final allocations must fit u64 (§4.2). The distribution engine already accepts any
non-negative bigint weight. So Y5 would add a weighted ownership input with unbounded weights, keeping the
snapshot's verification and commitment rules, rather than force weights into `rawShares`. This follows from
Option A (and B); it is not a new requirement.

**Still needed for real use:** D-12 Real (model), D-13 (disposition of unattributed or withheld amounts), D-14
(payout wallets at `calculate`), and Y0 operational (deploy hold lifted, J7 enabled, security sign-off).
