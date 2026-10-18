import { shiftDay, weekStart } from "./dates";

export const PERIODS = ["lastWeek", "thisWeek", "lastMonth", "thisMonth", "last30"] as const;
export type Period = (typeof PERIODS)[number];

/** Day of the month of `date` in a calendar ("gregory", "persian", …). */
export function dayOfMonth(date: string, calendar: string): number {
  const parts = new Intl.DateTimeFormat(`en-u-ca-${calendar}-nu-latn`, { day: "numeric", timeZone: "UTC" }).formatToParts(new Date(`${date}T00:00:00Z`));
  return Number(parts.find((p) => p.type === "day")!.value);
}

/**
 * The days a preset covers, ending today at the latest. Weeks start on the reader's first day of
 * the week; months follow the reader's calendar (Persian months for Persian readers).
 */
export function periodRange(period: Period, today: string, o: { weekStartsOn: number; calendar: string }): { from: string; to: string } {
  switch (period) {
    case "thisWeek":
      return { from: weekStart(today, o.weekStartsOn), to: today };
    case "lastWeek": {
      const start = weekStart(today, o.weekStartsOn);
      return { from: shiftDay(start, -7), to: shiftDay(start, -1) };
    }
    case "thisMonth":
      return { from: shiftDay(today, 1 - dayOfMonth(today, o.calendar)), to: today };
    case "lastMonth": {
      const end = shiftDay(today, -dayOfMonth(today, o.calendar));
      return { from: shiftDay(end, 1 - dayOfMonth(end, o.calendar)), to: end };
    }
    case "last30":
      return { from: shiftDay(today, -29), to: today };
  }
}
