/**
 * Equipment: machines and their maintenance. Service is due by running hours
 * (from hour-meter readings), by calendar days, or by whichever comes first.
 */
import { z } from "zod";
import { addDays, taskDateSchema } from "./tasks";

export const EQUIPMENT_KINDS = ["tractor", "sprayer", "harvester", "pump", "irrigation", "vehicle", "implement", "tool", "other"] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];

export const EQUIPMENT_STATUSES = ["active", "out_of_service", "retired"] as const;
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

const hours = z
  .string()
  .trim()
  .regex(/^\d{1,7}(\.\d)?$/, "hours with at most one decimal");

const fields = {
  name: z.string().trim().min(1).max(120),
  kind: z.enum(EQUIPMENT_KINDS),
  makeModel: z.string().trim().max(120).nullable(),
  serial: z.string().trim().max(80).nullable(),
  /** Farm the machine usually works on; maintenance tasks are created there. */
  farmId: z.string().uuid().nullable(),
  tracksHours: z.boolean(),
  status: z.enum(EQUIPMENT_STATUSES),
  statusNote: z.string().trim().max(500).nullable(),
  notes: z.string().trim().max(2_000).nullable(),
};

export const createEquipmentSchema = z
  .object({
    name: fields.name,
    kind: fields.kind,
    makeModel: fields.makeModel.optional(),
    serial: fields.serial.optional(),
    farmId: fields.farmId.optional(),
    tracksHours: fields.tracksHours.default(false),
    /** Hour meter now, when tracking hours. */
    currentHours: hours.nullable().optional(),
    notes: fields.notes.optional(),
  })
  .strict();
export type CreateEquipmentInput = z.infer<typeof createEquipmentSchema>;

export const updateEquipmentSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "nothing to change");
export type UpdateEquipmentInput = z.infer<typeof updateEquipmentSchema>;

export const meterReadingSchema = z.object({ hours, readOn: taskDateSchema, note: z.string().trim().max(500).nullable().optional() }).strict();

export const maintenancePlanSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    everyHours: z.number().int().min(1).max(100_000).nullable().optional(),
    everyDays: z.number().int().min(1).max(3_650).nullable().optional(),
    /** When it was last done, so the first due point is right. */
    lastDoneOn: taskDateSchema,
    lastDoneHours: hours.nullable().optional(),
    notes: z.string().trim().max(1_000).nullable().optional(),
  })
  .strict()
  .refine((p) => p.everyHours || p.everyDays, { message: "give an interval in hours, days or both", path: ["everyDays"] })
  .refine((p) => !p.everyHours || p.lastDoneHours != null, { message: "give the hour meter when it was last done", path: ["lastDoneHours"] });
export type MaintenancePlanInput = z.infer<typeof maintenancePlanSchema>;

export const serviceRecordSchema = z
  .object({
    planId: z.string().uuid().nullable().optional(),
    doneOn: taskDateSchema,
    hours: hours.nullable().optional(),
    description: z.string().trim().min(1).max(1_000),
    cost: z
      .string()
      .trim()
      .regex(/^\d{1,13}(\.\d{1,2})?$/)
      .nullable()
      .optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  })
  .strict()
  .refine((s) => (s.cost == null) === (s.currency == null), { message: "give both a cost and its currency, or neither", path: ["currency"] });
export type ServiceRecordInput = z.infer<typeof serviceRecordSchema>;

export type DueState = "overdue" | "soon" | "ok";

export interface DueInfo {
  state: DueState;
  dueOn: string | null;
  dueHours: number | null;
}

/**
 * When a maintenance plan is next due, and how urgent it is. "Soon" means
 * within 7 days or within 10% of the hour interval (at least 5 h).
 */
export function maintenanceDue(
  plan: { everyHours: number | null; everyDays: number | null; lastDoneOn: string; lastDoneHours: number | null },
  now: { today: string; hours: number | null },
): DueInfo {
  const dueOn = plan.everyDays ? addDays(plan.lastDoneOn, plan.everyDays) : null;
  const dueHours = plan.everyHours && plan.lastDoneHours != null ? plan.lastDoneHours + plan.everyHours : null;
  let state: DueState = "ok";
  const bump = (s: DueState) => {
    if (s === "overdue" || (s === "soon" && state === "ok")) state = s;
  };
  if (dueOn) {
    if (now.today >= dueOn) bump("overdue");
    else if (addDays(now.today, 7) >= dueOn) bump("soon");
  }
  if (dueHours != null && now.hours != null) {
    const margin = Math.max(5, plan.everyHours! * 0.1);
    if (now.hours >= dueHours) bump("overdue");
    else if (now.hours >= dueHours - margin) bump("soon");
  }
  return { state, dueOn, dueHours };
}
