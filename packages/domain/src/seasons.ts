/**
 * Crop seasons: one crop on one parcel (or the whole farm) from planting to the
 * end of harvest, with a log of growth stages. Harvests attach to a season;
 * inputs used on the parcel during the season are attributed to it.
 */
import { z } from "zod";
import { fromMilli, toMilli } from "./inventory";
import { taskDateSchema } from "./tasks";

export const SEASON_STATUSES = ["planned", "active", "closed"] as const;
export type SeasonStatus = (typeof SEASON_STATUSES)[number];

/** General growth stages that fit most crops; specific crops can add detail in the note. */
export const SEASON_STAGES = [
  "land-preparation",
  "sowing",
  "emergence",
  "vegetative",
  "flowering",
  "fruit-set",
  "ripening",
  "harvest",
  "post-harvest",
] as const;
export type SeasonStage = (typeof SEASON_STAGES)[number];

export const createSeasonSchema = z
  .object({
    cropName: z.string().trim().min(1).max(120),
    variety: z.string().trim().max(120).nullable().optional(),
    parcelLabel: z.string().trim().max(80).nullable().optional(),
    areaHa: z
      .string()
      .trim()
      .regex(/^\d{1,7}(\.\d{1,4})?$/)
      .refine((v) => Number(v) > 0)
      .nullable()
      .optional(),
    plannedStart: taskDateSchema,
    expectedHarvestFrom: taskDateSchema.nullable().optional(),
    status: z.enum(["planned", "active"]).default("active"),
    notes: z.string().trim().max(4_000).nullable().optional(),
  })
  .strict()
  .refine((s) => !s.expectedHarvestFrom || s.expectedHarvestFrom >= s.plannedStart, { message: "expected harvest must not be before the start", path: ["expectedHarvestFrom"] });
export type CreateSeasonInput = z.infer<typeof createSeasonSchema>;

export const updateSeasonSchema = z
  .object({
    variety: z.string().trim().max(120).nullable(),
    areaHa: z
      .string()
      .trim()
      .regex(/^\d{1,7}(\.\d{1,4})?$/)
      .refine((v) => Number(v) > 0)
      .nullable(),
    expectedHarvestFrom: taskDateSchema.nullable(),
    notes: z.string().trim().max(4_000).nullable(),
    status: z.enum(SEASON_STATUSES),
    /** Day the season ended; required when closing. */
    endedOn: taskDateSchema.nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "nothing to change");
export type UpdateSeasonInput = z.infer<typeof updateSeasonSchema>;

export const stageEntrySchema = z
  .object({
    stage: z.enum(SEASON_STAGES),
    observedOn: taskDateSchema,
    note: z.string().trim().max(2_000).nullable().optional(),
  })
  .strict();
export type StageEntryInput = z.infer<typeof stageEntrySchema>;

/** Sums quantities per unit exactly, e.g. harvest totals "1250.5 kg" + "3 t" stay separate. */
export function sumByUnit(rows: { quantity: string; unit: string }[]): { unit: string; quantity: string }[] {
  const totals = new Map<string, bigint>();
  for (const r of rows) totals.set(r.unit, (totals.get(r.unit) ?? 0n) + toMilli(r.quantity));
  return [...totals.entries()].map(([unit, m]) => ({ unit, quantity: fromMilli(m) })).sort((a, b) => a.unit.localeCompare(b.unit));
}

/** Yield per hectare for one unit, rounded to 3 decimals; null without an area. */
export function yieldPerHa(quantity: string, areaHa: string | null): string | null {
  if (!areaHa || Number(areaHa) <= 0) return null;
  return (Math.round((Number(quantity) / Number(areaHa)) * 1000) / 1000).toString();
}

/** Days from the start of the season to `today` (0 on the first day). */
export function daysSince(start: string, today: string): number {
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}
