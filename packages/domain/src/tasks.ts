/**
 * Field tasks: the day-to-day work a farm team does (irrigate, spray, harvest…).
 * Dates are calendar days in the farm's own time zone ("YYYY-MM-DD"), not instants.
 */
import { z } from "zod";

export const TASK_KINDS = [
  "irrigation",
  "fertilizing",
  "spraying",
  "planting",
  "weeding",
  "pruning",
  "harvest",
  "scouting",
  "maintenance",
  "other",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = ["todo", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** Statuses a task can be moved to by editing; "done" goes through completion. */
export const EDITABLE_TASK_STATUSES = ["todo", "in_progress", "cancelled"] as const;

export const TASK_PRIORITIES = ["low", "normal", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), "not a real date");

export const taskDateSchema = isoDate;

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    kind: z.enum(TASK_KINDS),
    parcelLabel: z.string().trim().max(80).nullable().optional(),
    assigneeUserId: z.string().uuid().nullable().optional(),
    dueDate: isoDate,
    priority: z.enum(TASK_PRIORITIES).default("normal"),
    notes: z.string().trim().max(4_000).nullable().optional(),
    /** Repeat this many days after the due date once completed (e.g. irrigation every 3 days). */
    repeatEveryDays: z.number().int().min(1).max(365).nullable().optional(),
  })
  .strict();
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    kind: z.enum(TASK_KINDS),
    parcelLabel: z.string().trim().max(80).nullable(),
    assigneeUserId: z.string().uuid().nullable(),
    dueDate: isoDate,
    priority: z.enum(TASK_PRIORITIES),
    notes: z.string().trim().max(4_000).nullable(),
    repeatEveryDays: z.number().int().min(1).max(365).nullable(),
    status: z.enum(EDITABLE_TASK_STATUSES),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "nothing to change");
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const completeTaskSchema = z
  .object({
    note: z.string().trim().max(4_000).optional(),
    /** Photos already uploaded to this farm (e.g. the finished work). */
    mediaIds: z.array(z.string().uuid()).max(10).default([]),
    /** Inputs used doing the task, recorded as stock use on the task's farm and parcel. */
    inputs: z
      .array(
        z
          .object({
            itemId: z.string().uuid(),
            quantity: z
              .string()
              .trim()
              .regex(/^\d{1,11}(\.\d{1,3})?$/, "a positive number with up to 3 decimals")
              .refine((q) => Number(q) > 0, "must be greater than zero"),
          })
          .strict(),
      )
      .max(10)
      .default([]),
  })
  .strict();
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;

/** Fields a worker may change on their own task; everything else needs task:manage. */
export function isWorkerOnlyUpdate(input: UpdateTaskInput): boolean {
  return Object.keys(input).every((k) => k === "status") && input.status !== "cancelled";
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Next due date of a repeating task, kept on its original rhythm: due date plus
 * whole intervals, skipping any that are already on or before the completion day.
 * Completing early therefore does not pull the schedule forward twice, and completing
 * late does not create a backlog of missed occurrences.
 */
export function nextOccurrence(dueDate: string, everyDays: number, completedOn: string): string {
  if (!Number.isInteger(everyDays) || everyDays < 1) throw new Error("everyDays must be a positive integer");
  let next = addDays(dueDate, everyDays);
  if (next <= completedOn) {
    const behind = Math.floor((Date.parse(`${completedOn}T00:00:00Z`) - Date.parse(`${next}T00:00:00Z`)) / 86_400_000);
    next = addDays(next, (Math.floor(behind / everyDays) + 1) * everyDays);
  }
  return next;
}

/** Calendar day of an instant in an IANA time zone, as YYYY-MM-DD. */
export function dayInZone(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}
