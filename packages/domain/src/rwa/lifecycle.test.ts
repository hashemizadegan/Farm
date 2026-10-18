import { describe, expect, it } from "vitest";
import { OPERATION_STATES, TERMINAL_STATES, TRANSITIONS, TransitionError, assertTransition, canTransition, mayRetryAfter, outcomeUnknown } from "./lifecycle";

describe("chain operation lifecycle", () => {
  it("walks the happy path in order", () => {
    const path = ["requested", "policy_approved", "prepared", "submitted", "observed", "confirmed", "business_completed"] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
  });

  it("never skips finality or goes backwards", () => {
    expect(canTransition("submitted", "confirmed")).toBe(false);
    expect(canTransition("submitted", "business_completed")).toBe(false);
    expect(canTransition("confirmed", "submitted")).toBe(false);
    expect(canTransition("requested", "prepared")).toBe(false);
    expect(() => assertTransition("observed", "requested")).toThrow(TransitionError);
  });

  it("ends in terminal states that go nowhere", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(["business_completed", "expired", "failed", "policy_rejected"]);
    for (const s of TERMINAL_STATES) for (const t of OPERATION_STATES) expect(canTransition(s, t)).toBe(false);
  });

  it("retries only attempts that provably never landed", () => {
    expect(mayRetryAfter("expired")).toBe(true);
    for (const s of OPERATION_STATES.filter((x) => x !== "expired")) expect(mayRetryAfter(s)).toBe(false);
    expect(outcomeUnknown("submitted")).toBe(true);
    expect(outcomeUnknown("observed")).toBe(true);
    expect(outcomeUnknown("prepared")).toBe(false);
  });

  it("lists every allowed transition once", () => {
    expect(new Set(TRANSITIONS.map(([a, b]) => `${a}>${b}`)).size).toBe(TRANSITIONS.length);
    expect(TRANSITIONS).toContainEqual(["observed", "expired"]);
  });
});
