# Real yield distribution: handoff record

The latest entry is on top. Each entry records what was completed (with the exact verification), what
is blocked and why, and the next action. The plan is
[`real-yield-distribution-plan.md`](real-yield-distribution-plan.md) (revision 4, `f914af4`); its
§11.1 gates decide what may be built. This record is separate from [`handoff.md`](handoff.md), which
belongs to the frozen #40–#59 stack.

## 2026-10-22, 02:45 local (shared 16,384-holder cycle across the #78 and #79 suites)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #80 | shared, memoized 16,384-holder cycle; `unit-shared-cycle` vitest project (tests and config only) | `feature/yield-shared-16k-cycle` | `631516e` | #79 | 39690915829 | 14/14 passed |

- **Helper:** `sharedLargeCycle(params)` is memoized on `globalThis`.
  - The key covers holders, seed, profile and dust threshold. Results are deeply frozen, parameters are checked
    strictly, and failed builds are not cached.
  - Simulation-only rules are unchanged.
  - `SHARED_16K` = 16,384 holders, seed `0xe17e10e5`, extreme profile, dust threshold 1,000.
- **Config:** vitest isolates modules per file, so sharing needs both files in one non-isolated process. The new
  `unit-shared-cycle` project (one fork, `isolate: false`) does this; `test:unit` runs it with `unit`.
- **Invariants:** #79 pins unchanged. #78 has no pins at 16,384 holders (bounds only) and now uses the shared
  dust-1,000 cycle. #78's 4,096-holder pins are unchanged. The memo test proves the key includes seed and dust
  threshold.
- **Finding:** the unit job took 191 s, up from 107 s. Sharing serializes the two heavy files, which previously ran in
  parallel. Recommendation: keep the helper and memo test, drop the `unit-shared-cycle` project. Awaiting the
  owner's choice.
- **Holds unchanged:** no production code; simulation only; no chain, network, storage, signing, deployment or merge.

## 2026-10-22, 02:30 local (claim read model: low-memory single-holder lookups)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #79 | claim read model: indexed records, image round trip, C# sample | `feature/yield-claim-read-model` | `cf10f41` | #78 | 39689244592 | 14/14 passed |

Commits: `8681fb2` (read model; tree-level helpers; claim-lookup indexing), `bde2016` (tests, C# sample), `ec01ce8` (test
fix after the first CI run), `cf10f41` (test strategy revised for CI time; tests only).

- **Interfaces:** `ClaimReadModelStore` (get) and `ClaimReadModelSink` (put; records are immutable). Only an in-memory
  store exists. A durable store would implement the same two interfaces.
- **Records:**
  - a header: published tree, cycle summary, tree level sizes;
  - holder records: claim with leaf index, withheld, or deferred with its reason;
  - unattributed holdings and a recipient index;
  - leaves (layout 2 bytes);
  - each tree node once, by level and index.
- **Queries:** opening reads the header only, pinned by the expected artifact hash. A claim costs 2 + path-length reads
  (at most about 1.5 KB at 16,384 holders), and the proof is rebuilt from stored nodes. Every claim is verified against
  the pinned tree before it is served; tampered leaves, nodes or index records give `corrupt`.
- **Persistence:** a deterministic byte image pinned by SHA-256 (4,096 holders: `79f1704f…`, 4,067,466 bytes). It
  round-trips to identical bytes. There is no file, database or network I/O.
- **Tests:** at 4,096 and 16,384 holders, every holder's result equals the in-memory lookup's, with exact read counts.
  Fail-closed checks cover projection, open, queries and images.
- **C#:** `claim-readmodel.sample.json` claims are identical to the #78 large-tree sample's. `ReadModelCrossStackTests`
  decodes every layout 2 leaf exactly and verifies every claim.
- **Also:** `createClaimLookup` now indexes plan entries once. Behaviour is unchanged; lookups had been quadratic.
- **Test strategy (`cf10f41`, owner request, tests only):**
  - 4,096 holders keep the full every-holder cross-check.
  - 16,384 holders (fixed seed, dust threshold 1,000) check instead:
    - the pinned image (`4c0ff458…`, 16,412,652 bytes) and its round trip;
    - exact hash calls: projection L leaf + (Σpath + L − 1) node, and 1 + path per served claim;
    - a stable seeded subset of 1,024 holders (`splitMix64(0x5b5e7)`, plus the first `below_dust_threshold` holder,
      which the pick missed), covering claims, withheld, `zero_amount` and `below_dust_threshold`;
    - read-count bounds;
    - tamper detection.
  - The unit job takes 107 s, down from 144 s (73 s on #78).
- **CI note:** the first run (`bde2016`, run 39686212325) failed in Unit tests. A deep `toEqual` over the ~16 MB image
  enumerates every index in vitest. Fixed by a byte loop. The unit job now takes 144 s (73 s on #78), mostly the
  all-holder check at 16,384 holders.
- **Holds unchanged:** simulation only; no chain, network, storage, signing, deployment or merge.

## 2026-10-22, 02:00 local (large-holder performance and memory envelopes)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #78 | deterministic envelope tests, large-tree C# sample (tests only) | `feature/yield-large-holder-envelope` | `db3bbe0` | #77 | 39683144164 | 14/14 passed |

- **Deterministic envelopes:** cost is counted in hash calls (a counting hasher), not timed.
  - Tree build makes exactly L leaf and L − 1 node hashes at 4,096 and 16,384 holders.
  - The pipeline makes exactly 2L leaf and (L − 1) + Σpath node hashes.
  - Opening the lookup costs exactly L + Σpath hashes, and each claim verifies with exactly 1 + path-length hashes.
  - Proof lengths match RFC 9162 exactly.
  - The artifact is pinned for a seeded 4,096-holder cycle (SHA-256 `3e374c9b…`, 7,487,231 bytes), stable on rerun and
    after a JSON round trip.
- **Caps only (stable in CI):** < 120 s and < 1 GiB heap growth per build; 16,384-holder artifact ≤ 2,560 bytes per holder
  and < 64 MiB; 512 lookups verified in < 60 s. The unit-test job time did not grow (73 s).
- **Cross-stack:** `claim-payloads.large-tree.sample.json` (43 claims with proofs up to 12 deep, 21 `zero_amount`
  deferrals), verified in C# (`LargeTreeCrossStackTests`) and by an independent Python RFC 9162 verifier.
- **Holds unchanged:** no production code changed; simulation only; no chain, network, storage, signing, deployment or
  merge.

## 2026-10-22, 01:30 local (zero-allocation policy: option B)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #77 | zero-allocation policy, TS and C# | `feature/yield-zero-allocation` | `ba3b7f0` | #76 | 39680962950 | 14/14 passed |

- **Decision (owner asked for one): option B.** A payable entry is never 0. A party whose amount is 0 is `deferred` with
  `deferredReason: "zero_amount"`, whatever the dust threshold.
  - The rule is fixed, not configurable: no wallet → withheld; amount 0 → deferred `zero_amount` (takes precedence);
    below the threshold → deferred `below_dust_threshold`; otherwise payable.
  - Why B rather than A: it keeps `dustThreshold: 0n` valid instead of pre-empting D-9. It also holds for any threshold
    and is enforced at every layer. On leaves and roots it is equivalent to A: threshold 0 and 1 give the same root on
    1,200 extreme holders.
  - A zero amount carries nothing forward, so conservation is unchanged. Non-zero amounts keep their previous states.
- **Where it is enforced:**
  - the planner (`partyEntryState`);
  - the pipeline's `calculate` and `cycleArtifactProblems` (`distribution_invalid`);
  - the leaf encoder and decoder in TS and C#, so proof and payload verification reject a zero leaf in both stacks;
  - the claim lookup, which reports the deferral reason to holders.
- **Cross-stack:** new `Samples/claim-payloads.tiny-holders.sample.json` (31 claims, 13 `zero_amount` deferrals). C#
  recomputes the allocation and states with `BigInteger` and requires an exact match, and an independent Python check
  agrees. In the regenerated `claim-payloads.sample.json`, the root and claims are unchanged; only the artifact hash and
  one lookup reason changed.
- **Holds unchanged:** simulation only; no chain, network, signing, deployment or merge.

## 2026-10-22, 01:00 local (ownership ingestion interface; 1,000+ holder stress harness)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #76 | ownership ingestion interface, simulation adapters, synthetic generator, scale tests | `feature/yield-ownership-ingestion` | `670d624` | #75 | 39678157321 | 14/14 passed |

- **Interface:** `IOwnershipSourceAdapter` returns a `VerifiedOwnershipSnapshot`. `loadVerifiedOwnershipSnapshot` is the entry
  point and fails closed:
  - real-network requests are refused before the adapter is called;
  - only `simulationOnly: true` adapters are accepted;
  - the result must re-verify, be frozen, and answer the request (asset, network, reference, verification time).
- **Adapters:**
  - `MockOwnershipAdapter`: deterministic synthetic data.
  - `FileFixtureOwnershipAdapter`: a strict JSON fixture with decimal-string u64s, read through an injected reader, with an
    optional SHA-256 pin. The domain reads no files.
  - A chain-backed adapter (Y0/Y5) is still blocked on D-16, D-12 and D-17.
- **Generator:** SplitMix64 over bigints, canonical order by construction, uniform, skewed and extreme u64 profiles. The
  committed 40-holder fixture is reproduced byte for byte by an independent Python implementation.
- **Scale:** the pipeline with layout 2 leaves over 1,024, 1,537, 1,200 (extreme: total > 100 × u64), 2,048 and 4,096
  holders. Each run is checked independently: every proof, every leaf, the root via the twin implementation, exact
  largest-remainder allocation, conservation, and determinism by seed. No stack or size limits were hit.
- **Finding (no behaviour change):** with the simulation default `dustThreshold: 0n` (pending D-9), a zero allocation is a
  payable entry, and the claim tree refuses the whole cycle (fail closed). Real datasets with tiny holders need a threshold
  of at least 1, or a D-9 rule deferring zero allocations.
- **Holds unchanged:** no chain, RPC, network, signing, deployment or merge.

## 2026-10-22, 00:27 local (owner decision: leaf layout 2 approved)

The owner approved claim leaf layout 2 in these terms:

- Layout 2 binds claims to a verified ownership snapshot without breaking layout 1.
- It is byte-identical to layout 1 for the first 201 bytes and appends a 32-byte SHA-256 `snapshot_hash`: 233 bytes.
- Layout 1 stays supported; its existing parity vectors stay authoritative.
- The pipeline and new artifacts may require layout 2; verification fails closed on layout confusion or a snapshot
  mismatch.
- Snapshot normalisation refuses non-canonical (unsorted) input; it does not re-sort silently.

This records the decision only; the plan document is not changed. The code on #75 already met every point. The
owner's "byte-identical" holds in every byte except offset 195, the layout version itself (1 or 2), which is the byte
that keeps the layouts apart. One test was added to pin these rules in TypeScript as well as C#: `64187cd` on #75
(`claim-tree.test.ts`, "keeps layouts 1 and 2 apart"). The yield tests touched by #75 pass locally (claim tree 17,
snapshot 14, pipeline 21, lookup 6). CI on `64187cd`: 14/14 checks passed, including lint.

Where each point is enforced:

| Point | TypeScript | C# |
| --- | --- | --- |
| 201-byte prefix + 32-byte hash | `encodeClaimLeaf`, `claim-tree.test.ts` | `ClaimLeafCodec`, `TheCodecKeepsLayoutsApart` |
| Layout 1 vectors authoritative | `claim-tree.vectors.test.ts` (unchanged) | `ClaimTreeParityTests` |
| Pipeline requires layout 2 | `pipeline.ts` (`ownership_unbound`) | — |
| Fail closed on confusion or mismatch | `decodeClaimLeaf`, `verifyClaimPayload` | `ClaimLeafCodec.Decode`, `ClaimPayloadVerification` |
| No silent re-sort | `ownership-snapshot.ts` (`not_canonical_order`) | — |

## 2026-10-21, night (ownership snapshot verifier; leaf layout 2)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #75 | ownership snapshot verifier, bound into the pipeline and every leaf | `feature/yield-ownership-snapshot` | `b7854a7` | #74 | 39664489877 | 14/14 passed; C# 82 passed (81 on #74) |

- **Snapshot verifier:** `verifyAndNormalizeSnapshot` takes raw u64 shares as bigints and returns a deeply frozen
  `VerifiedOwnershipSnapshot`, with exact integer share bases and a SHA-256 commitment (matches an independent Python
  vector).
  - Network ids: simulation only; real networks are refused.
  - Parties: unique and already in canonical order; unsorted input is refused.
  - Payout addresses: unique after normalisation.
  - Total: an exact bigint sum, refused if zero.
  - This verifies a snapshot as data. Reading ownership from a chain (Y0, Y5) is still not built.
- **Pipeline binding:** the pipeline consumes the verified snapshot.
  - It requires the snapshot's asset to match the leaves' asset and builds **leaf layout 2**: the §6.2 leaf plus the
    32-byte snapshot hash, 233 bytes.
  - The artifact embeds the snapshot; verification recomputes its hash, requires it in every leaf, and requires the
    plan's shares and addresses to match it.
  - A one-unit share change or an address change fails verification, even with the snapshot and artifact hashes
    recomputed.
- **Needs owner acknowledgement (approved 2026-10-22, see above):** leaf layout 2 is an addition to the plan's §6.2 table, which defines layout 1
  only. The plan document is not changed. Layout 1 and its parity vectors are untouched.
- **C#:** the codec handles layout 2; the payload verifier requires the trusted snapshot hash inside the leaf.
- **Holds unchanged:** no signing, chain or network access.

## 2026-10-21, late night (simulation cycle pipeline; claim lookup; C# cross-stack check)

| PR | Scope | Branch | Head | Base | CI run | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| #72 | pipeline base (#71 + #68, merge only) | `feature/yield-pipeline-base` | `d337374` | #71 | 39647092532 | 14/14 passed |
| #73 | simulation cycle pipeline | `feature/yield-cycle-pipeline` | `3abb337` | #72 | 39647564986 | 14/14 passed; C# 77 passed |
| #74 | claim lookup and C# cross-stack verification | `feature/yield-claim-lookup` | `6c944de` | #73 | 39648432879 | 14/14 passed; C# 81 passed (+4 cross-stack tests) |

- **Pipeline (#73), simulation only:**
  - `calculate` (`inputs_locked` → `calculated`) goes from committed evidence (Y4), through aggregation with recorded
    FX and the waterfall, to the distribution plan, the claim tree and a verified, frozen artifact.
  - `calculate` is refused if any proof fails `verifyClaimLeafProof` or conservation breaks.
  - `submit` (`calculated` → `under_review`) re-verifies the artifact (hash, every proof, conservation).
  - The plan's state machine has no "committed" state: the artifact set is frozen at `calculate` (§2.2). No state was
    added to Y1.
  - **Conservation:** claim leaves + dust carried + withheld + unattributed + carried remainder = inflow (the net
    distributable amount plus anything carried in).
- **Claim lookup (#74):**
  - A read-only lookup over a verified simulation artifact, by party id or payout address.
  - It returns the `metafarm-yield-claim/1` payload, or the reason there is no leaf (deferred, withheld,
    unattributed, not in cycle).
  - `verifyClaimPayload` binds the trusted published tree and the cycle id and version inside the leaf.
- **Cross-stack check (#74):**
  - `clients/unity-starter/Samples/claim-payloads.sample.json` is generated from #73's live multi-party pipeline run;
    a vitest test fails if the committed file differs.
  - The C# client deserializes it with its own settings and runs `VerifyClaimLeafProof` and
    `ClaimPayloadVerification` on every claim.
- **Still caller-supplied:** ownership snapshots (Y0 and Y5 not built). No signing, chain or network access.

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
