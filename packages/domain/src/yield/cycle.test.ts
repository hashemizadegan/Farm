import { describe, expect, it } from "vitest";
import {
  YIELD_CYCLE_COMMANDS,
  YIELD_CYCLE_STATES,
  YIELD_PRE_PUBLICATION_STATES,
  YIELD_TERMINAL_STATES,
  YIELD_TRANSITIONS,
  type YieldTransitionError,
  findYieldTransition,
  assertYieldFourEyes,
  isTerminalYieldState,
  yieldTransitionTarget,
  type YieldCycleState,
} from "./cycle";

const real = { simulation: false } as const;
const sim = { simulation: true } as const;

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as YieldTransitionError).code;
  }
  return "no error";
};

describe("yield cycle transitions", () => {
  it("follows the plan's main path from draft to published", () => {
    const path: [string, YieldCycleState][] = [
      ["lock", "inputs_locked"],
      ["calculate", "calculated"],
      ["submit", "under_review"],
      ["approve", "approved"],
      ["publish", "published"],
    ];
    let s: YieldCycleState = "draft";
    for (const [cmd, to] of path) {
      s = yieldTransitionTarget(s, cmd as never, real);
      expect(s).toBe(to);
    }
  });

  it("unlocks and rejects back to the right states", () => {
    expect(yieldTransitionTarget("inputs_locked", "unlock", real)).toBe("draft");
    expect(yieldTransitionTarget("calculated", "unlock", real)).toBe("inputs_locked");
    expect(yieldTransitionTarget("under_review", "reject", real)).toBe("inputs_locked");
  });

  it("cancels or abandons every state before publication, and nothing after", () => {
    for (const s of YIELD_CYCLE_STATES) {
      const pre = (YIELD_PRE_PUBLICATION_STATES as readonly string[]).includes(s);
      expect(code(() => yieldTransitionTarget(s, "cancel", real))).toBe(pre ? "no error" : "invalid_transition");
      expect(code(() => yieldTransitionTarget(s, "expire", real))).toBe(pre ? "no error" : "invalid_transition");
    }
  });

  it("refuses every pair that is not in the table", () => {
    for (const s of YIELD_CYCLE_STATES)
      for (const c of YIELD_CYCLE_COMMANDS) {
        const row = YIELD_TRANSITIONS.find((t) => t.from === s && t.command === c);
        if (!row) expect(code(() => yieldTransitionTarget(s, c, { ...real, closeReason: "unfunded", stateBeforeDispute: "published" }))).toBe("invalid_transition");
      }
    // A few the plan calls out: no reopening, no skipping review, nothing leaves a terminal state.
    expect(code(() => yieldTransitionTarget("published", "unlock", real))).toBe("invalid_transition");
    expect(code(() => yieldTransitionTarget("calculated", "approve", real))).toBe("invalid_transition");
    expect(code(() => yieldTransitionTarget("draft", "publish", real))).toBe("invalid_transition");
    for (const t of YIELD_TERMINAL_STATES) for (const c of YIELD_CYCLE_COMMANDS) expect(code(() => yieldTransitionTarget(t, c, real))).not.toBe("no error");
  });

  it("has at most one row per state and command", () => {
    const keys = YIELD_TRANSITIONS.map((t) => `${t.from}|${t.command}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("always refuses the future phases, and never funds a simulation cycle", () => {
    expect(code(() => yieldTransitionTarget("published", "fund", real))).toBe("future_phase");
    expect(code(() => yieldTransitionTarget("published", "fund", sim))).toBe("simulation_not_fundable");
    expect(code(() => yieldTransitionTarget("funded", "distribute", real))).toBe("future_phase");
    expect(code(() => yieldTransitionTarget("distributing", "close", { ...real, closeReason: "distributed" }))).toBe("future_phase");
    expect(code(() => yieldTransitionTarget("funded", "dispute", real))).toBe("future_phase");
  });

  it("closes a published cycle only with a reason allowed for it", () => {
    expect(code(() => yieldTransitionTarget("published", "close", real))).toBe("close_reason_required");
    for (const r of ["no_distribution", "loss", "unfunded"] as const) expect(yieldTransitionTarget("published", "close", { ...real, closeReason: r })).toBe("closed");
    expect(code(() => yieldTransitionTarget("published", "close", { ...real, closeReason: "simulation" }))).toBe("close_reason_not_allowed");
    expect(yieldTransitionTarget("published", "close", { ...sim, closeReason: "simulation" })).toBe("closed");
    expect(code(() => yieldTransitionTarget("published", "close", { ...real, closeReason: "distributed" }))).toBe("close_reason_not_allowed");
    expect(code(() => yieldTransitionTarget("published", "close", { ...real, closeReason: "whatever" as never }))).toBe("close_reason_not_allowed");
    // A disputed cycle cannot be closed: the dispute must be dismissed first.
    expect(code(() => yieldTransitionTarget("disputed", "close", { ...real, closeReason: "unfunded" }))).toBe("invalid_transition");
  });

  it("dismissing a dispute returns to the state before it, which must be given and disputable", () => {
    expect(yieldTransitionTarget("published", "dispute", real)).toBe("disputed");
    expect(code(() => yieldTransitionTarget("disputed", "dismiss", real))).toBe("previous_state_required");
    expect(yieldTransitionTarget("disputed", "dismiss", { ...real, stateBeforeDispute: "published" })).toBe("published");
    expect(code(() => yieldTransitionTarget("disputed", "dismiss", { ...real, stateBeforeDispute: "draft" }))).toBe("invalid_transition");
    expect(code(() => yieldTransitionTarget("disputed", "dismiss", { ...real, stateBeforeDispute: "funded" }))).toBe("invalid_transition");
  });

  it("supersedes published or disputed cycles", () => {
    expect(yieldTransitionTarget("published", "supersede", real)).toBe("superseded");
    expect(yieldTransitionTarget("disputed", "supersede", real)).toBe("superseded");
  });

  it("requires the simulation flag explicitly", () => {
    expect(code(() => yieldTransitionTarget("draft", "lock", {} as never))).toBe("invalid_transition");
  });

  it("reaches every terminal state from draft without future phases", () => {
    const reached = new Set<YieldCycleState>();
    const queue: YieldCycleState[] = ["draft"];
    const seen = new Set<YieldCycleState>(queue);
    while (queue.length) {
      const s = queue.shift()!;
      for (const c of YIELD_CYCLE_COMMANDS) {
        for (const ctx of [
          { ...real, closeReason: "unfunded" as const, stateBeforeDispute: "published" as const },
          { ...sim, closeReason: "simulation" as const, stateBeforeDispute: "published" as const },
        ]) {
          let to: YieldCycleState;
          try {
            to = yieldTransitionTarget(s, c, ctx);
          } catch {
            continue;
          }
          if (isTerminalYieldState(to)) reached.add(to);
          if (!seen.has(to)) {
            seen.add(to);
            queue.push(to);
          }
        }
      }
    }
    expect([...reached].sort()).toEqual([...YIELD_TERMINAL_STATES].sort());
    expect(seen.has("funded")).toBe(false);
    expect(seen.has("distributing")).toBe(false);
  });
});

describe("four-eyes", () => {
  it("refuses the same or a missing identity", () => {
    expect(() => assertYieldFourEyes("u1", "u2")).not.toThrow();
    expect(code(() => assertYieldFourEyes("u1", "u1"))).toBe("four_eyes");
    expect(code(() => assertYieldFourEyes("", "u2"))).toBe("four_eyes");
    expect(code(() => assertYieldFourEyes("u1", ""))).toBe("four_eyes");
  });

  it("cannot be bypassed with whitespace variants or non-string identities", () => {
    expect(code(() => assertYieldFourEyes("u1", "u1 "))).toBe("four_eyes");
    expect(code(() => assertYieldFourEyes(" u1", "u1"))).toBe("four_eyes");
    expect(code(() => assertYieldFourEyes("   ", "u1"))).toBe("four_eyes");
    expect(code(() => assertYieldFourEyes(undefined as never, "u1"))).toBe("four_eyes");
    expect(code(() => assertYieldFourEyes(1 as never, 2 as never))).toBe("four_eyes");
  });
});

describe("actors (plan §2.1 table)", () => {
  it("approve is a reviewer's command; publish, cancel and close are an approver's", () => {
    expect(findYieldTransition("under_review", "approve")?.actor).toBe("reviewer");
    expect(findYieldTransition("under_review", "reject")?.actor).toBe("reviewer");
    expect(findYieldTransition("approved", "publish")?.actor).toBe("approver");
    expect(findYieldTransition("draft", "cancel")?.actor).toBe("approver");
    expect(findYieldTransition("published", "close")?.actor).toBe("approver");
    expect(findYieldTransition("draft", "expire")?.actor).toBe("system");
    expect(findYieldTransition("disputed", "dismiss")?.actor).toBe("dispute_authority");
  });
});
