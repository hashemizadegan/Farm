import { describe, expect, it } from "vitest";
import { OPERATION_STATES } from "./lifecycle";
import { decideToken2022Retry, type LastAttempt, type RetryDecision, type ShareTokenIntent, type Token2022Evidence } from "./token2022-reconciliation";

const mint: ShareTokenIntent = { action: "mint", amount: 1_000n };
const burn: ShareTokenIntent = { action: "burn", amount: 400n };
const expired: LastAttempt = { state: "expired", attempt: 1, lastValidBlockHeight: 5_000n };

/** Evidence for a mint that provably did not land: signature unknown, supply and balance as before. */
const untouched: Token2022Evidence = {
  finalizedBlockHeight: 5_200n,
  signature: "not_found",
  otherUnsettledOnMint: 0,
  supply: { expected: 10_000n, observed: 10_000n },
  balance: { expected: 0n, observed: 0n },
  frozen: null,
};

/** Named scenarios: the fixtures that document the rule (docs/rwa-architecture.md). */
const FIXTURES: { name: string; intent: ShareTokenIntent; last?: Partial<LastAttempt>; evidence?: Partial<Token2022Evidence>; expect: RetryDecision }[] = [
  { name: "mint never landed (signature unknown, nothing changed)", intent: mint, expect: { kind: "retry", basis: "signature_not_found" } },
  { name: "mint failed on chain, nothing changed", intent: mint, evidence: { signature: "failed" }, expect: { kind: "retry", basis: "signature_failed" } },
  {
    name: "mint landed, signature pruned: supply and balance moved by the amount",
    intent: mint,
    evidence: { supply: { expected: 10_000n, observed: 11_000n }, balance: { expected: 0n, observed: 1_000n } },
    expect: { kind: "landed", basis: "state_changed_exactly" },
  },
  {
    name: "mint landed, signature found",
    intent: mint,
    evidence: { signature: "succeeded", supply: { expected: 10_000n, observed: 11_000n }, balance: { expected: 0n, observed: 1_000n } },
    expect: { kind: "landed", basis: "signature_succeeded" },
  },
  {
    name: "signature found successful but nothing changed",
    intent: mint,
    evidence: { signature: "succeeded" },
    expect: { kind: "reconcile", reason: "signature_succeeded_but_state_unchanged", detail: "the transaction succeeded but the chain shows no change from it" },
  },
  {
    name: "supply moved but the balance did not (someone else's change)",
    intent: mint,
    evidence: { supply: { expected: 10_000n, observed: 11_000n } },
    expect: { kind: "reconcile", reason: "unexplained_change", detail: "the chain differs from the platform's records by something other than this action" },
  },
  {
    name: "the holder burned some of their own shares meanwhile",
    intent: mint,
    evidence: { supply: { expected: 10_000n, observed: 9_900n }, balance: { expected: 0n, observed: 0n } },
    expect: { kind: "reconcile", reason: "unexplained_change", detail: "the chain differs from the platform's records by something other than this action" },
  },
  {
    name: "burn landed, signature pruned",
    intent: burn,
    evidence: { supply: { expected: 10_000n, observed: 9_600n }, balance: { expected: 1_000n, observed: 600n } },
    expect: { kind: "landed", basis: "state_changed_exactly" },
  },
  { name: "burn never landed", intent: burn, evidence: { balance: { expected: 1_000n, observed: 1_000n } }, expect: { kind: "retry", basis: "signature_not_found" } },
  {
    name: "freeze landed, signature pruned",
    intent: { action: "freeze", amount: 0n },
    evidence: { supply: null, balance: null, frozen: { expected: false, observed: true } },
    expect: { kind: "landed", basis: "state_changed_exactly" },
  },
  {
    name: "freeze never landed",
    intent: { action: "freeze", amount: 0n },
    evidence: { supply: null, balance: null, frozen: { expected: false, observed: false } },
    expect: { kind: "retry", basis: "signature_not_found" },
  },
  {
    name: "thaw requested but the records already say the account was thawed",
    intent: { action: "thaw", amount: 0n },
    evidence: { supply: null, balance: null, frozen: { expected: false, observed: false } },
    expect: { kind: "reconcile", reason: "unexplained_change", detail: "the chain differs from the platform's records by something other than this action" },
  },
  { name: "blockhash not yet past its limit at finalized", intent: mint, evidence: { finalizedBlockHeight: 5_000n }, expect: { kind: "wait", reason: "could_still_land" } },
  { name: "never prepared (no validity limit)", intent: mint, last: { lastValidBlockHeight: null }, expect: { kind: "wait", reason: "could_still_land" } },
  { name: "another attempt on the same mint is unsettled", intent: mint, evidence: { otherUnsettledOnMint: 1 }, expect: { kind: "wait", reason: "other_attempts_in_flight" } },
  { name: "the node could not be asked", intent: mint, evidence: { signature: "unavailable" }, expect: { kind: "wait", reason: "evidence_unavailable" } },
  { name: "supply could not be read", intent: mint, evidence: { supply: null }, expect: { kind: "wait", reason: "evidence_unavailable" } },
  { name: "a zero mint", intent: { action: "mint", amount: 0n }, expect: { kind: "reconcile", reason: "invalid_intent", detail: "a mint needs a positive amount" } },
];

describe("decideToken2022Retry", () => {
  it.each(FIXTURES)("$name", ({ intent, last, evidence, expect: want }) => {
    expect(decideToken2022Retry(intent, { ...expired, ...last }, { ...untouched, ...evidence })).toEqual(want);
  });

  it("allows a retry only after an expired attempt, and waits while the outcome is unknown", () => {
    for (const state of OPERATION_STATES) {
      const d = decideToken2022Retry(mint, { ...expired, state }, untouched);
      if (state === "expired") expect(d.kind).toBe("retry");
      else if (state === "submitted" || state === "observed") expect(d).toEqual({ kind: "wait", reason: "outcome_unknown" });
      else expect(d).toEqual({ kind: "not_applicable", reason: "not_expired" });
    }
  });

  it("never allows a retry when any evidence shows a change", () => {
    // Every combination of small supply and balance changes: only (0, 0) may retry.
    for (const ds of [-1_000n, -1n, 0n, 1n, 1_000n])
      for (const db of [-1_000n, -1n, 0n, 1n, 1_000n])
        for (const signature of ["not_found", "failed", "succeeded"] as const) {
          const d = decideToken2022Retry(mint, expired, { ...untouched, signature, supply: { expected: 10_000n, observed: 10_000n + ds }, balance: { expected: 0n, observed: db } });
          if (d.kind === "retry") expect([ds, db, signature !== "succeeded"]).toEqual([0n, 0n, true]);
        }
  });
});
