import { describe, expect, it } from "vitest";
import { periodDays, reportQuerySchema } from "./reports";

describe("report periods", () => {
  it("counts both ends", () => {
    expect(periodDays("2026-10-12", "2026-10-18")).toBe(7);
    expect(periodDays("2026-10-18", "2026-10-18")).toBe(1);
    expect(periodDays("2024-01-01", "2024-12-31")).toBe(366);
  });
  it("accepts up to a year and rejects reversed ranges", () => {
    expect(reportQuerySchema.safeParse({ from: "2026-10-12", to: "2026-10-18" }).success).toBe(true);
    expect(reportQuerySchema.safeParse({ from: "2026-10-19", to: "2026-10-18" }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ from: "2024-01-01", to: "2025-01-02" }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ from: "2026-02-30", to: "2026-03-01" }).success).toBe(false);
  });
});
