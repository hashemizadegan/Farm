/**
 * Harvest batches and their public traceability record.
 *
 * The public record is the only thing a buyer sees and the only thing that is
 * fingerprinted on-chain (as SHA-256 of its canonical JSON). It deliberately
 * excludes people, coordinates and private notes.
 */
import { z } from "zod";
import { taskDateSchema } from "./tasks";

export const HARVEST_RECORD_VERSION = 1 as const;

/** Unambiguous characters for codes people read off a label (no 0/O, 1/I/L). */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const HARVEST_CODE = /^[2-9A-HJKMNP-Z]{10}$/;

export const ANCHOR_STATUSES = ["not_configured", "pending", "submitted", "confirmed", "failed"] as const;
export type AnchorStatus = (typeof ANCHOR_STATUSES)[number];

export const createHarvestSchema = z
  .object({
    cropName: z.string().trim().min(1).max(120),
    parcelLabel: z.string().trim().max(80).nullable().optional(),
    harvestedOn: taskDateSchema,
    /** Decimal with up to 3 places, as text so no precision is lost. */
    quantity: z
      .string()
      .trim()
      .regex(/^\d{1,11}(\.\d{1,3})?$/, "a positive number with up to 3 decimals")
      .refine((q) => Number(q) > 0, "must be greater than zero"),
    unit: z.string().trim().min(1).max(16),
    qualityGrade: z.string().trim().max(40).nullable().optional(),
    /** Private to the workspace; never published. */
    notes: z.string().trim().max(4_000).nullable().optional(),
    taskId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type CreateHarvestInput = z.infer<typeof createHarvestSchema>;

export const voidHarvestSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export interface HarvestPublicRecord {
  v: typeof HARVEST_RECORD_VERSION;
  batch: string;
  producer: string;
  farm: string;
  crop: string;
  parcel: string | null;
  harvestedOn: string;
  quantity: string;
  unit: string;
  grade: string | null;
  recordedAt: string;
}

export function buildHarvestRecord(input: {
  code: string;
  producer: string;
  farm: string;
  harvest: CreateHarvestInput;
  recordedAt: Date;
}): HarvestPublicRecord {
  const h = input.harvest;
  return {
    v: HARVEST_RECORD_VERSION,
    batch: input.code,
    producer: input.producer,
    farm: input.farm,
    crop: h.cropName,
    parcel: h.parcelLabel || null,
    harvestedOn: h.harvestedOn,
    quantity: normalizeQuantity(h.quantity),
    unit: h.unit,
    grade: h.qualityGrade || null,
    // Whole seconds: the record must survive a round trip through any JSON tool unchanged.
    recordedAt: new Date(Math.floor(input.recordedAt.getTime() / 1000) * 1000).toISOString(),
  };
}

/** "0012.500" → "12.5": one spelling per value, so the fingerprint is stable. */
export function normalizeQuantity(q: string): string {
  const [int, frac = ""] = q.trim().split(".");
  const i = int!.replace(/^0+(?=\d)/, "");
  const f = frac.replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

/** JSON with object keys sorted at every level and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/** SHA-256 hex of the canonical record. Works in browsers and Node (Web Crypto). */
export async function harvestRecordHash(record: HarvestPublicRecord | Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(record));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Random label code from `bytes` (inject for tests). */
export function harvestCode(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  // Rejection sampling keeps every character equally likely.
  const out: string[] = [];
  while (out.length < 10) {
    for (const b of random(16)) {
      if (b < 248 && out.length < 10) out.push(CODE_ALPHABET[b % 31]!);
    }
  }
  return out.join("");
}

/** On-chain batch id: the batch's UUID as a left-padded bytes32. */
export function harvestChainId(batchUuid: string): `0x${string}` {
  const hex = batchUuid.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("not a UUID");
  return `0x${hex.padStart(64, "0")}`;
}

/** Human-readable ABI of contracts/nft/contracts/HarvestRegistry.sol (for viem's parseAbi). Keep in sync. */
export const HARVEST_REGISTRY_ABI = [
  "function record(bytes32 batchId, bytes32 recordHash)",
  "function voidBatch(bytes32 batchId, bytes32 reasonHash)",
  "function entryOf(bytes32 batchId) view returns (bytes32 recordHash, uint64 recordedAt, uint64 voidedAt)",
  "event BatchRecorded(bytes32 indexed batchId, bytes32 recordHash, address indexed recorder)",
  "event BatchVoided(bytes32 indexed batchId, bytes32 reasonHash, address indexed recorder)",
  "error AlreadyRecorded(bytes32 batchId)",
  "error NotRecorded(bytes32 batchId)",
  "error AlreadyVoided(bytes32 batchId)",
  "error ZeroValue()",
] as const;
