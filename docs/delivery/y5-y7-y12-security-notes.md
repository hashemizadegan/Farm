# Security notes: Y5, Y7, Y12 (input to the proposed security sign-off; not a sign-off)

Prepared 2026-10-22 by the implementing agent, the same way as `y0-security-review.md`. An independent review is
still required (plan §11.2).

## Y5 (#86): holdings and provenance

- **Provenance (F2):**
  - a verified RPC cursor serves only identity-bound RPC events;
  - fixture rows are kept, never served, for that asset;
  - ambiguous provenance (a fixture cursor beside verified RPC events) is refused;
  - fixture batches over a verified RPC cursor are refused in the worker and again in the cursor upsert;
  - mixed fixture/RPC combined sources are refused.
- **Reader:** runs as `metafarm_app` in a read-only transaction, joined to the verified identity. Pre-0023 RPC rows
  remain unserved (F1 fix kept).
- **Arithmetic:** integer only. Window at most 2^32 slots, total weight at most 2^128 − 1. Inputs are checked
  (`weightedOwnershipProblems`) and committed (SHA-256 over canonical JSON).
- **Residual:**
  - the provenance rules rely on the cursor table's `source` column;
  - a superuser can still edit rows directly (outside the threat model of the application role);
  - the reconciliation endpoint (Y14) and the reader both detect the ambiguous case.

## Y7 (#87): yield schema

- **Row-level security:** forced on all eight tables.
- **Grants:** no DELETE. UPDATE only on `yield_cycles`, through a guard trigger.
- **Trigger-only writes:** artifact-set status and the transition log are written only by `SECURITY DEFINER`
  triggers with a pinned `search_path`. `EXECUTE` is revoked from `PUBLIC`.
- **State machine:** in the database. Future phases are unreachable.
- **Four-eyes:** the approver may be neither the creator nor the preparer.
- **Transition actor:** each transition must name its actor. Actor and reason are cleared after logging, so they
  cannot be inherited.
- **D-17:** a fixture snapshot is refused for a non-simulation cycle, and the `simulation` flag is immutable.
- **Amounts:** limited to u64 by CHECK. Weights are limited to u128.
- **Residual:**
  - the owner role (migrations) can still disable triggers;
  - triggers with `SECURITY DEFINER` run as the migration owner. Review that role's rights in deployment;
  - `status_reason` is free text (≤ 2000 characters): treat it as personal data under the retention policy.

## Y12 (#92): account-to-party links

- **Steps:** proposed → consented (by the linked member, recording consent version and SHA-256) → active (authorised
  by someone who is neither the proposer nor the member) → revoked (terminal).
- **Uniqueness:** one live link per party and per member.
- **Immutability:** recorded steps cannot change, and the event log is append-only and trigger-written.
- **No derivation:** a link never creates or derives a party. Holder access reads only `activePartyOfUser`.
- **Switch:** off by default, refused in production. The consent text is a working draft and is flagged
  `approved: false`.
- **Residual:**
  - the member must already belong to the workspace. How investors become members is outside this stage;
  - consent is the signed-in member's request, not a cryptographic signature;
  - revocation takes effect on the next request, with no session invalidation needed, because nothing is cached.
