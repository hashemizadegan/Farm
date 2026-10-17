import { describe, expect, it } from "vitest";
import { createSeasonSchema, daysSince, sumByUnit, yieldPerHa } from "./seasons";

describe("crop seasons", () => {
  it("validates the dates", () => {
    expect(createSeasonSchema.safeParse({ cropName: "Wheat", plannedStart: "2026-11-01", expectedHarvestFrom: "2026-10-01" }).success).toBe(false);
    const s = createSeasonSchema.parse({ cropName: " Wheat ", plannedStart: "2026-11-01", expectedHarvestFrom: "2027-06-01", areaHa: "12.5" });
    expect(s).toMatchObject({ cropName: "Wheat", status: "active" });
  });

  it("sums harvests exactly, per unit", () => {
    expect(sumByUnit([
      { quantity: "0.1", unit: "t" },
      { quantity: "1250.5", unit: "kg" },
      { quantity: "0.2", unit: "t" },
      { quantity: "-0.5", unit: "kg" },
    ])).toEqual([
      { unit: "kg", quantity: "1250" },
      { unit: "t", quantity: "0.3" },
    ]);
  });

  it("computes yield per hectare and season age", () => {
    expect(yieldPerHa("1250", "2.5")).toBe("500");
    expect(yieldPerHa("10", null)).toBeNull();
    expect(daysSince("2026-10-01", "2026-10-18")).toBe(17);
  });
});
