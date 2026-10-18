/** Workspace settings kept in tenants.settings, and when the weekly summary goes out. */
import { z } from "zod";
import { dayInZone } from "./tasks";

export interface WeeklyReportSettings {
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  weekStartsOn: number;
}

/** Hour of the local morning on the first day of the week from which the summary is sent. */
export const WEEKLY_REPORT_HOUR = 7;

// Where the working week starts on Saturday.
const SATURDAY_ZONES = new Set(["Asia/Tehran", "Asia/Kabul"]);

/** The week start a workspace gets until someone chooses: Saturday in Iran and Afghanistan, otherwise Monday. */
export function defaultWeekStart(timezone: string | null | undefined): number {
  return timezone && SATURDAY_ZONES.has(timezone) ? 6 : 1;
}

const weeklyReportSchema = z.object({ enabled: z.boolean(), weekStartsOn: z.number().int().min(0).max(6) }).strict();

export const workspaceSettingsSchema = z
  .object({ name: z.string().trim().min(1).max(200).optional(), weeklyReport: weeklyReportSchema.optional() })
  .strict()
  .refine((s) => s.name !== undefined || s.weeklyReport !== undefined, { message: "nothing to change" });
export type WorkspaceSettingsInput = z.infer<typeof workspaceSettingsSchema>;

/** Stored settings with defaults filled in; unknown or malformed values fall back to the defaults. */
export function readWorkspaceSettings(raw: unknown, timezone: string | null | undefined): { weeklyReport: WeeklyReportSettings } {
  const stored = weeklyReportSchema.safeParse((raw as { weeklyReport?: unknown } | null)?.weeklyReport);
  return { weeklyReport: stored.success ? stored.data : { enabled: true, weekStartsOn: defaultWeekStart(timezone) } };
}

function hourInZone(instant: Date, timeZone: string): number {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(instant));
  } catch {
    return instant.getUTCHours();
  }
}

const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The week the summary covers, when it is due: on the first day of a new week from 07:00 local
 * time it is the seven days just ended; at any other time nothing is due.
 */
export function weeklyReportDue(now: Date, timezone: string, weekStartsOn: number): { from: string; to: string } | null {
  const today = dayInZone(now, timezone);
  if (new Date(`${today}T00:00:00Z`).getUTCDay() !== weekStartsOn || hourInZone(now, timezone) < WEEKLY_REPORT_HOUR) return null;
  return { from: shift(today, -7), to: shift(today, -1) };
}
