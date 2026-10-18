/** Period reports: what the team recorded between two calendar days. */
import { z } from "zod";
import { taskDateSchema } from "./tasks";

export const REPORT_MAX_DAYS = 366;

/** Days from `from` to `to`, both included. */
export function periodDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export const reportQuerySchema = z
  .object({ farmId: z.string().uuid().optional(), from: taskDateSchema, to: taskDateSchema })
  .refine((q) => q.from <= q.to, { message: "from must not be after to", path: ["from"] })
  .refine((q) => periodDays(q.from, q.to) <= REPORT_MAX_DAYS, { message: `at most ${REPORT_MAX_DAYS} days`, path: ["to"] });
