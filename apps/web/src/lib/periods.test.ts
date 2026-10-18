import { describe, expect, it } from "vitest";
import { dayOfMonth, periodRange } from "./periods";

const greg = { weekStartsOn: 1, calendar: "gregory" };
const persian = { weekStartsOn: 6, calendar: "persian" };

describe("report periods", () => {
  it("covers last week and this week from the reader's first weekday", () => {
    // 2026-10-18 is a Sunday.
    expect(periodRange("lastWeek", "2026-10-18", greg)).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    expect(periodRange("thisWeek", "2026-10-18", greg)).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(periodRange("lastWeek", "2026-10-18", persian)).toEqual({ from: "2026-10-10", to: "2026-10-16" });
    expect(periodRange("thisWeek", "2026-10-18", persian)).toEqual({ from: "2026-10-17", to: "2026-10-18" });
  });

  it("follows Gregorian months", () => {
    expect(periodRange("thisMonth", "2026-10-18", greg)).toEqual({ from: "2026-10-01", to: "2026-10-18" });
    expect(periodRange("lastMonth", "2026-10-18", greg)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(periodRange("lastMonth", "2026-03-10", greg)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("follows Persian months", () => {
    // 2026-10-18 is 26 Mehr 1405; Mehr began on 2026-09-23 and Shahrivar ran 2026-08-23 … 2026-09-22.
    expect(dayOfMonth("2026-10-18", "persian")).toBe(26);
    expect(periodRange("thisMonth", "2026-10-18", persian)).toEqual({ from: "2026-09-23", to: "2026-10-18" });
    expect(periodRange("lastMonth", "2026-10-18", persian)).toEqual({ from: "2026-08-23", to: "2026-09-22" });
  });

  it("covers the last 30 days including today", () => {
    expect(periodRange("last30", "2026-10-18", greg)).toEqual({ from: "2026-09-19", to: "2026-10-18" });
  });
});
