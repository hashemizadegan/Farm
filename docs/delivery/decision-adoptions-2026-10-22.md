# Decisions applied while building Y5–Y15 (2026-10-22)

**What this is:** a record of which decision each stage was built under. Only D-12 (Build) and D-17 were approved by
the owner (2026-10-22). Every other row is the plan's **documented recommendation**, applied under the owner's
standing instruction to use repository recommendations for technically implementable areas. **None of them is a
sign-off.** Each still needs its listed signers (plan §12), and the code is switched off or simulation-only until
then.

| Decision | Applied as | Source | Where | Still needed |
| --- | --- | --- | --- | --- |
| D-12 (Build) | slot-weighted holdings, integer, bounded | **owner approval 2026-10-22** | #86 | D-12 Real gate (P, T, L) |
| D-17 | staged: service (Y5), database (Y7); F2 = verified RPC takes precedence | **owner approval 2026-10-22** | #86, #87 | — (approved) |
| D-31 | reuse `audit_events`; state history in append-only transition logs | §7.2 provisional recommendation | #87 | T, L confirmation; proposed S sign-off |
| D-28 | new `yield:*` permissions; `verifier` extended as auditor | §12 register recommendation | #88 | T, P confirmation |
| D-11 | freeze at `calculate` | §12 register recommendation | #89 | P, T confirmation |
| D-29 | explicit, consented, authorised, revocable, audited link | §12 register recommendation | #92 | L, P, T; [Legal] consent wording (D-39); proposed S sign-off |
| D-26 | **not applied** | recommendation is "SHA-256, pending on-chain cost verification [Ext]" | — | the [Ext] verification; Y6 final stays on the yield line |

## Conservative choices made where no recommendation exists

Each is fail-closed and documented in code:

- **Real cycles:** the database stops a non-simulation cycle at `inputs_locked` (`yield_cycles_real_gate`), and the
  API refuses to create one (409 `real_gate`). Lifting either needs the Real gates of plan §2.1.
- **Evidence:** simulation-only until D-24 (`yield_evidence_simulation_only`).
- **Four-eyes on cycles:** the approver may be neither the creator nor the preparer.
- **Simulation attestation quorum:** one active attestation of the frozen set's hash. A simulation-only default,
  not a policy (D-23 governs real quorums).
- **Calculation engine:** none on the ownership line. `calculate` and `preview` answer 503
  `calculation_engine_unavailable` until the yield line is joined (an owner decision).
- **Switches:** `YIELD_WORKFLOW_ENABLED` and `PARTY_LINKS_ENABLED` are off by default and refused in production;
  `HOLDER_YIELD_ENABLED` and `NEXT_PUBLIC_YIELD_PAGES_ENABLED` are off by default and refused in staging and
  production.
- **`parties.user_id` (0012)** is never treated as an account-to-party link.
