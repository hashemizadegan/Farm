# Real yield distribution: handoff record

The latest entry is on top. Each entry records what was completed (with the exact verification), what
is blocked and why, and the next action. The plan is
[`real-yield-distribution-plan.md`](real-yield-distribution-plan.md) (revision 4, `f914af4`); its
§11.1 gates decide what may be built. This record is separate from [`handoff.md`](handoff.md), which
belongs to the frozen #40–#59 stack.

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
| #62 yield stack base | `feature/yield-stack-base` | `e709cf8` | 39619248296 | 13 of 14 passed; Dependency audit still running at the time of writing (the run reported success while that job was in progress) |
| #63 Y3: evidence and attestation model | `feature/yield-y3-evidence` | `6bd2ad4` | 39619589979 | Install, Lint, Typecheck, Unit, Integration, Contract, Audit, Build, Unity core passed; Docker images and Playwright still running at the time of writing |

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
