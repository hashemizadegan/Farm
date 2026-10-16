import { describe, expect, it } from "vitest";
import { SCENARIO_DISCLAIMER, ScenarioInputError, runCropScenario } from "./scenarios";

const input = {
  cropName: "Example crop",
  plantedAreaHa: 2,
  yieldPerHa: { low: 1, base: 2, high: 3 },
  yieldUnit: "t",
  pricePerUnit: { low: 100, base: 150, high: 200 },
  costs: { low: 50, base: 100, high: 150 },
  currency: "USD",
};

describe("runCropScenario", () => {
  it("is always labelled simulated with the disclaimer", () => {
    const r = runCropScenario(input);
    expect(r.kind).toBe("simulated");
    expect(r.provenance).toBe("user-entered");
    expect(r.disclaimer).toBe(SCENARIO_DISCLAIMER);
  });

  it("brackets pessimistic and optimistic cases from user inputs only", () => {
    const r = runCropScenario(input);
    expect(r.cases.low).toEqual({ production: 2, grossRevenue: 200, costs: 150, net: 50 });
    expect(r.cases.base).toEqual({ production: 4, grossRevenue: 600, costs: 100, net: 500 });
    expect(r.cases.high).toEqual({ production: 6, grossRevenue: 1200, costs: 50, net: 1150 });
  });

  it("rejects inconsistent ranges and bad currency", () => {
    expect(() => runCropScenario({ ...input, yieldPerHa: { low: 3, base: 2, high: 1 } })).toThrow(ScenarioInputError);
    expect(() => runCropScenario({ ...input, currency: "usd" })).toThrow(ScenarioInputError);
    expect(() => runCropScenario({ ...input, plantedAreaHa: 0 })).toThrow(ScenarioInputError);
    expect(() => runCropScenario({ ...input, costs: { low: -1, base: 0, high: 1 } })).toThrow(ScenarioInputError);
  });
});
