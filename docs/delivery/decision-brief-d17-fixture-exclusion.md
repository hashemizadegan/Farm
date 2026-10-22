# Decision brief: D-17, enforcement layers for fixture exclusion

**Status: OPEN — FOR REVIEW ONLY (NO APPROVALS).** Prepared 2026-10-22 against plan revision 4 (`f914af4`).

**Sources:**
- §12 register, D-17: "Enforcement layers for fixture exclusion (exclusion is a safeguard)". Options: DB /
  service / tests. Provisional: all three. Signer T.
- Gate: **Build** (Y5, Y7). Effect while open: Y5 and Y7 can't be written.
- §0.3 (D-17 decides *how*, not *whether*), §4.2 (fixture exclusion rules), §4.3 ("Test assets: simulation
  cycles only"), §11.1 rows Y5 and Y7, safeguard 14.

## Owner decision (recorded 2026-10-22)

The owner approved **staged fixture exclusion**: Y5 service-level refusal; Y7 database-level enforcement in the
snapshot tables; fixtures only for simulation and tests; real and fixture data never silently combined. **F2 is
resolved as "verified RPC takes precedence":** when verified RPC rows exist for an asset, its fixture rows are not
served; fixture rows stay simulation-only; mixed-source behaviour is explicit, deterministic and tested; ambiguous
provenance fails closed. Historical fixture data is not deleted.

Implemented:
- **Service (Y5, #86):** `buildWeightedOwnershipInput` refuses fixture history for a non-simulation input
  (`fixture_in_real_cycle`) and unverified or foreign-network RPC identities (`unverified_source`).
- **F2 (#86):** `readVerifiedOwnershipHistory` serves only identity-bound RPC events under a verified RPC cursor
  (fixture rows kept, never served); a fixture cursor beside verified RPC events is `ambiguous_provenance`; a fixture
  batch over a verified RPC cursor is refused twice (worker, cursor upsert: `fixture_after_verified_rpc`); a source
  switch restarts the cursor; `combineOwnershipSources` refuses mixing fixture and RPC members.
- **Database (Y7, #87):** `yield_ownership_snapshots` refuses fixture snapshots for non-simulation cycles (trigger
  joining `yield_cycles.simulation`, whose `simulation` flag is immutable); RPC snapshots must reference a verified
  identity of their own network.

The status line above is left as written, as the record of what was proposed.

## Problem

Whether fixture ownership is excluded from real cycles is **not open**; it is a safeguard (§0.3).

**Rules (§4.2):**
- a real or legally effective cycle may use only `source = 'rpc'` events and cursors from a verified source;
- `fixture` events are for simulation, tests and demonstrations only;
- a tree containing fixture ownership is simulation-only.

**What D-17 decides is where that is enforced.** Safeguard 14 already sketches all three layers:
- **DB:** a trigger on snapshots;
- **service:** `calculate` refuses;
- **tests:** fixture events plus a non-simulation cycle → refused.

**Current state of the code:**
- J7 rows carry `source` (`fixture` | `rpc`, 0020).
- Y0 (#85) requires every `rpc` row to reference a verified identity and refuses an identity on `fixture` rows.
- The yield pipeline is simulation-only: its snapshot verifier refuses real networks.
- Snapshots and cycles are not database tables yet; they arrive in Y7.

## Options

| | A. All three layers (provisional) | B. Service and tests only | C. Database only |
| --- | --- | --- | --- |
| Service | Y5's ownership computation and `calculate` refuse fixture-sourced data for a non-simulation cycle | same | none |
| Database | Y7: a constraint or trigger refusing a non-simulation snapshot or cycle that references fixture-sourced data | none | same as A |
| Tests | fixture events + non-simulation cycle → refused, at each layer | service tests | DB tests |
| Strength | defence in depth: a bug or bypass in one layer is caught by the other | one layer; direct SQL or a bug bypasses it | no early, explainable refusal in the service |
| Scope | service + tests in Y5; DB in Y7 (where the tables are created) | smallest | Y7 only, so Y5 has no enforcement |

## Recommendation

**Option A, all three layers, staged with the plan's PRs:**
- **Y5:** the service layer and its tests. Y5's ownership computation refuses any fixture-sourced event or cursor
  for a non-simulation cycle, and `calculate` refuses fixture-derived snapshots. Tests cover fixture events
  with a non-simulation cycle.
- **Y7:** the database layer and its tests. When the snapshot and cycle tables are created, a constraint or
  trigger refuses a non-simulation record that references fixture-sourced data, as safeguard 14 specifies.

This is the provisional value and the only option giving defence in depth for a stated safeguard. Staging it
this way adds no scope beyond what Y5 and Y7 already contain.

## Point surfaced by the Y0 security review (for the owner to settle within D-17)

Finding **F2** (`y0-security-review.md`):
- Fixture and RPC rows can coexist for one asset in the J7 index, and the reader serves both.
- `combineOwnershipSources` reports a combined source as `rpc` if any member is RPC.

The plan's rule ("only `source = 'rpc'` … from a verified source" for real cycles) implies that a non-simulation
read of an asset must use **only** bound RPC rows. Within Option A, the service layer would apply that filter.
Whether the J7 index should also refuse mixing the two sources for one asset is a design choice for D-17. This
brief does not assume it.

## What approving D-17 unblocks

- **Y5**, with D-12 (Build). Y0 is implemented in #85.
- The fixture-exclusion part of **Y7**, which still needs D-31 (audit storage).
