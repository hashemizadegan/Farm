import { describe, expect, it } from "vitest";
import { D39_SIMULATION_DISCLOSURE, fourEyes, groupDigits, shortHash, viewState, yieldPagesBuildProblem, yieldPagesEnabled, yieldStatusKey, yieldTone } from "./yield";

describe("yield page helpers (Y10)", () => {
  it("is off unless the flag is exactly true, and refused in deployed builds", () => {
    expect(yieldPagesEnabled({})).toBe(false);
    expect(yieldPagesEnabled({ NEXT_PUBLIC_YIELD_PAGES_ENABLED: "1" })).toBe(false);
    expect(yieldPagesEnabled({ NEXT_PUBLIC_YIELD_PAGES_ENABLED: "true" })).toBe(true);
    expect(yieldPagesBuildProblem({ NEXT_PUBLIC_YIELD_PAGES_ENABLED: "true", APP_ENV: "production" })).toMatch(/D-39/);
    expect(yieldPagesBuildProblem({ NEXT_PUBLIC_YIELD_PAGES_ENABLED: "true", APP_ENV: "staging" })).toMatch(/D-39/);
    expect(yieldPagesBuildProblem({ NEXT_PUBLIC_YIELD_PAGES_ENABLED: "true", APP_ENV: "development" })).toBeNull();
    expect(yieldPagesBuildProblem({ APP_ENV: "production" })).toBeNull();
  });

  it("words statuses as the plan does and never shows a loss or no-yield cycle as merely closed", () => {
    expect(yieldStatusKey("closed", "loss")).toBe("closed_loss");
    expect(yieldStatusKey("closed", "no_distribution")).toBe("closed_no_distribution");
    expect(yieldStatusKey("closed", "simulation")).toBe("closed");
    expect(yieldStatusKey("under_review")).toBe("under_review");
    expect(yieldTone("disputed")).toBe("problem");
    expect(yieldTone("draft")).toBe("pending");
  });

  it("distinguishes loading, error, stale, empty and fresh deterministically", () => {
    const empty = (d: number[]) => d.length === 0;
    expect(viewState({ loading: true }, empty)).toBe("loading");
    expect(viewState({ loading: false, error: new Error("x") }, empty)).toBe("error");
    expect(viewState({ loading: false, data: [1], error: new Error("x") }, empty)).toBe("stale");
    expect(viewState({ loading: false, data: [] }, empty)).toBe("empty");
    expect(viewState({ loading: true, data: [1] }, empty)).toBe("fresh");
  });

  it("formats hashes and big integers without losing digits", () => {
    expect(shortHash("a".repeat(64))).toBe("aaaaaaaa…aaaaaaaa");
    expect(shortHash(null)).toBeNull();
    expect(groupDigits("18446744073709551615")).toBe("18,446,744,073,709,551,615");
    expect(groupDigits("999")).toBe("999");
    expect(groupDigits("-1")).toBe("-1");
  });

  it("shows the adopted D-39 simulation wording verbatim", () => {
    expect(D39_SIMULATION_DISCLOSURE).toBe(
      "SIMULATION ONLY: Yield metrics, cycles, and claim intents displayed in this interface are generated from deterministic simulation models. No real assets, mainnet signatures, or monetary liabilities are incurred.",
    );
  });

  it("summarises four-eyes from the history: the latest preparer and approver, and whether they differ", () => {
    expect(fourEyes([{ command: "calculate", actorUserId: "p" }, { command: "approve", actorUserId: "a" }])).toEqual({ preparedBy: "p", approvedBy: "a", separated: true });
    expect(fourEyes([{ command: "calculate", actorUserId: "p" }])).toEqual({ preparedBy: "p", approvedBy: null, separated: null });
    expect(fourEyes([{ command: "calculate", actorUserId: "x" }, { command: "unlock", actorUserId: "x" }, { command: "calculate", actorUserId: "p" }]).preparedBy).toBe("p");
  });
});

