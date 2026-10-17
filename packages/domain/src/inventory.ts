/**
 * Farm inputs: seed, fertilizer, crop protection products, fuel… Stock on hand
 * is the sum of an append-only movement log; mistakes are corrected with an
 * adjustment, never by editing history (the log doubles as the spray/fertilizer record).
 */
import { z } from "zod";
import { taskDateSchema } from "./tasks";

export const INPUT_CATEGORIES = ["seed", "fertilizer", "crop-protection", "fuel", "packaging", "other"] as const;
export type InputCategory = (typeof INPUT_CATEGORIES)[number];

export const MOVEMENT_KINDS = ["receive", "use", "adjust"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/** Positive decimal with up to 3 places, as text (no float rounding). */
const qty = z
  .string()
  .trim()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, "a positive number with up to 3 decimals")
  .refine((q) => Number(q) > 0, "must be greater than zero");
/** Signed decimal for stock-count corrections. */
const signedQty = z
  .string()
  .trim()
  .regex(/^-?\d{1,11}(\.\d{1,3})?$/, "a number with up to 3 decimals")
  .refine((q) => Number(q) !== 0, "must not be zero");

const itemFields = {
  name: z.string().trim().min(1).max(120),
  category: z.enum(INPUT_CATEGORIES),
  unit: z.string().trim().min(1).max(16),
  /** Warn when stock falls to or below this. */
  reorderLevel: z
    .string()
    .trim()
    .regex(/^\d{1,11}(\.\d{1,3})?$/)
    .nullable(),
  /** Pre-harvest interval: days between the last application and harvest (from the product label). */
  preHarvestIntervalDays: z.number().int().min(0).max(365).nullable(),
  /** Re-entry interval: hours before people may enter the treated area. */
  reEntryHours: z.number().int().min(0).max(720).nullable(),
  notes: z.string().trim().max(2_000).nullable(),
};

export const createInputItemSchema = z
  .object({
    ...itemFields,
    reorderLevel: itemFields.reorderLevel.optional(),
    preHarvestIntervalDays: itemFields.preHarvestIntervalDays.optional(),
    reEntryHours: itemFields.reEntryHours.optional(),
    notes: itemFields.notes.optional(),
  })
  .strict();
export type CreateInputItemInput = z.infer<typeof createInputItemSchema>;

export const updateInputItemSchema = z
  .object({ ...itemFields, archived: z.boolean() })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "nothing to change");
export type UpdateInputItemInput = z.infer<typeof updateInputItemSchema>;

export const movementSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("receive"),
      itemId: z.string().uuid(),
      quantity: qty,
      occurredOn: taskDateSchema,
      supplier: z.string().trim().max(120).nullable().optional(),
      lot: z.string().trim().max(60).nullable().optional(),
      expiresOn: taskDateSchema.nullable().optional(),
      /** Total cost of this delivery. */
      cost: z
        .string()
        .trim()
        .regex(/^\d{1,13}(\.\d{1,2})?$/)
        .nullable()
        .optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
      note: z.string().trim().max(1_000).nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("use"),
      itemId: z.string().uuid(),
      quantity: qty,
      occurredOn: taskDateSchema,
      farmId: z.string().uuid(),
      parcelLabel: z.string().trim().max(80).nullable().optional(),
      taskId: z.string().uuid().nullable().optional(),
      note: z.string().trim().max(1_000).nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("adjust"),
      itemId: z.string().uuid(),
      /** Signed: +found, -lost/spoiled. */
      quantity: signedQty,
      occurredOn: taskDateSchema,
      note: z.string().trim().min(3).max(1_000),
    })
    .strict(),
]);
export type MovementInput = z.infer<typeof movementSchema>;

/** Stock arithmetic in thousandths, so sums never drift. */
export function toMilli(q: string): bigint {
  const neg = q.trim().startsWith("-");
  const [i, f = ""] = q.trim().replace(/^-/, "").split(".");
  const v = BigInt(i!) * 1000n + BigInt((f + "000").slice(0, 3));
  return neg ? -v : v;
}

export function fromMilli(m: bigint): string {
  const neg = m < 0n;
  const a = neg ? -m : m;
  const frac = (a % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / 1000n}${frac ? `.${frac}` : ""}`;
}

/** Whether a harvest on `harvestOn` is inside the pre-harvest interval of an application on `appliedOn`. */
export function withinPreHarvestInterval(appliedOn: string, phiDays: number, harvestOn: string): boolean {
  const earliest = new Date(`${appliedOn}T00:00:00Z`);
  earliest.setUTCDate(earliest.getUTCDate() + phiDays);
  return harvestOn < earliest.toISOString().slice(0, 10);
}

/** The first day a harvest is allowed after an application. */
export function harvestAllowedFrom(appliedOn: string, phiDays: number): string {
  const d = new Date(`${appliedOn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + phiDays);
  return d.toISOString().slice(0, 10);
}
