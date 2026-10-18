import { describe, expect, it } from "vitest";
import { defaultWeekStart, readWorkspaceSettings, weeklyReportDue, workspaceSettingsSchema } from "./workspace";

describe("weekly summary", () => {
  it("starts weeks on Saturday in Iran and Afghanistan, Monday elsewhere", () => {
    expect(defaultWeekStart("Asia/Tehran")).toBe(6);
    expect(defaultWeekStart("Asia/Kabul")).toBe(6);
    expect(defaultWeekStart("Europe/Berlin")).toBe(1);
    expect(defaultWeekStart(null)).toBe(1);
  });

  it("fills in defaults and ignores malformed stored values", () => {
    expect(readWorkspaceSettings({}, "Asia/Tehran")).toEqual({ weeklyReport: { enabled: true, weekStartsOn: 6 } });
    expect(readWorkspaceSettings({ weeklyReport: { enabled: false, weekStartsOn: 0 } }, "Asia/Tehran")).toEqual({ weeklyReport: { enabled: false, weekStartsOn: 0 } });
    expect(readWorkspaceSettings({ weeklyReport: { enabled: "yes" } }, "UTC").weeklyReport).toEqual({ enabled: true, weekStartsOn: 1 });
    expect(readWorkspaceSettings(null, undefined).weeklyReport.enabled).toBe(true);
  });

  it("is due from 07:00 local on the first day of the week, for the seven days just ended", () => {
    // Saturday 2026-10-17 in Tehran (UTC+03:30): 06:59 is too early, 07:00 is due.
    expect(weeklyReportDue(new Date("2026-10-17T03:29:00Z"), "Asia/Tehran", 6)).toBeNull();
    expect(weeklyReportDue(new Date("2026-10-17T03:30:00Z"), "Asia/Tehran", 6)).toEqual({ from: "2026-10-10", to: "2026-10-16" });
    // Late on Saturday is still Saturday locally.
    expect(weeklyReportDue(new Date("2026-10-17T20:00:00Z"), "Asia/Tehran", 6)).toEqual({ from: "2026-10-10", to: "2026-10-16" });
    // Sunday in Tehran: not the first day of a Saturday week.
    expect(weeklyReportDue(new Date("2026-10-18T05:00:00Z"), "Asia/Tehran", 6)).toBeNull();
    // Monday weeks in UTC.
    expect(weeklyReportDue(new Date("2026-10-19T08:00:00Z"), "UTC", 1)).toEqual({ from: "2026-10-12", to: "2026-10-18" });
  });

  it("accepts a name, the summary settings or both", () => {
    expect(workspaceSettingsSchema.safeParse({ name: "Farm" }).success).toBe(true);
    expect(workspaceSettingsSchema.safeParse({ weeklyReport: { enabled: false, weekStartsOn: 6 } }).success).toBe(true);
    expect(workspaceSettingsSchema.safeParse({}).success).toBe(false);
    expect(workspaceSettingsSchema.safeParse({ weeklyReport: { enabled: true, weekStartsOn: 7 } }).success).toBe(false);
  });
});
