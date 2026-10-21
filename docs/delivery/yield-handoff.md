# Real yield distribution: handoff record

The latest entry is on top. Each entry records what was completed (with the exact verification), what
is blocked and why, and the next action. The plan is
[`real-yield-distribution-plan.md`](real-yield-distribution-plan.md) (revision 4, `f914af4`); its
§11.1 gates decide what may be built. This record is separate from [`handoff.md`](handoff.md), which
belongs to the frozen #40–#59 stack.

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
