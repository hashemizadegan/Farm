/**
 * Evidence items and the evidence bundle manifest (Real Yield Distribution plan, revision 4, §5.1–5.2).
 *
 * The model only: no storage, no I/O. Evidence bytes live in private storage (Y4); here an item is its
 * metadata and the SHA-256 of its exact bytes. Which storage and retention apply to real evidence is an
 * open decision (D-24): an item names its retention class by id, and nothing here chooses one.
 *
 * Manifest (plan §5.1): canonical JSON `{ scheme: "metafarm-yield-evidence/1", cycleId, cycleVersion,
 * items }`, items sorted by (type, contentSha256) in code-unit order. Its SHA-256 is part of the
 * artifact set. The canonical form is the repository's `canonicalJson` (keys sorted, no whitespace).
 */
import { canonicalJson } from "../harvest";
import { contentHash, isSha256Hex } from "../twin/commitments";

export const EVIDENCE_MANIFEST_SCHEME = "metafarm-yield-evidence/1";

/** Evidence types of plan §5.2. */
export const EVIDENCE_TYPES = [
  "weighbridge_receipt",
  "warehouse_receipt",
  "sales_invoice",
  "customs_record",
  "bank_settlement_record",
  "stablecoin_settlement_record",
  "equipment_telemetry",
  "iot_data",
  "weather_data",
  "auditor_attestation",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** Classifications used in plan §5.2. Evidence is never public; public outputs carry totals and hashes only. */
export const EVIDENCE_CLASSIFICATIONS = ["internal", "confidential", "restricted"] as const;
export type EvidenceClassification = (typeof EVIDENCE_CLASSIFICATIONS)[number];

export interface EvidenceItem {
  type: EvidenceType;
  /** SHA-256 (lowercase hex) of the exact bytes. */
  contentSha256: string;
  /** Size of the exact bytes. */
  byteSize: number;
  /** IANA media type, e.g. `application/pdf`. */
  mediaType: string;
  /** When the document was issued: RFC 3339 with an offset. */
  issuedAt: string;
  /** IANA time zone for documents dated in local time, or null when the document is not local-dated. */
  timeZone: string | null;
  /** Identifier of the source (e.g. an invoice number); a source backs at most one live input (plan §3.4). */
  sourceId: string;
  recordedBy: string;
  /** RFC 3339 with an offset. */
  recordedAt: string;
  classification: EvidenceClassification;
  /** Retention class by id (D-24). Required; never defaulted. */
  retentionClassId: string;
  /** The content hash of the item this one corrects, or null. */
  supersedes: string | null;
}

export type YieldEvidenceErrorCode = "invalid_evidence" | "duplicate_evidence" | "integrity_mismatch";

export class YieldEvidenceError extends Error {
  constructor(
    readonly code: YieldEvidenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "YieldEvidenceError";
  }
}

const ITEM_KEYS = ["type", "contentSha256", "byteSize", "mediaType", "issuedAt", "timeZone", "sourceId", "recordedBy", "recordedAt", "classification", "retentionClassId", "supersedes"] as const;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
// RFC 6838 type/subtype (restricted names), lowercase, no parameters.
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * RFC 3339 date-time with an explicit offset, naming a real calendar date and time. `Date.parse` alone is
 * not enough: it rolls impossible values forward (2026-02-30 becomes 2026-03-02, 24:00 the next day).
 * Leap seconds (second 60) are refused, and so are the lowercase `t` and `z` that RFC 3339 §5.6 permits:
 * only the uppercase form is accepted, so each instant has fewer spellings.
 */
export function isRfc3339WithOffset(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = RFC3339.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  // Proleptic Gregorian, computed directly: Date.UTC maps years 0–99 to 1900–1999.
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysInMonth = mo >= 1 && mo <= 12 ? ([31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] as number) : 0;
  if (d < 1 || d > daysInMonth || h > 23 || mi > 59 || sec > 59) return false;
  if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return false;
  return !Number.isNaN(Date.parse(v));
}

/** An IANA time zone name the runtime recognises (e.g. `Asia/Tehran`, `UTC`). */
export function isIanaTimeZone(v: unknown): v is string {
  if (typeof v !== "string" || v === "") return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

/** Every problem with an evidence item, or an empty list. Nothing is filled in. */
export function evidenceItemProblems(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["an evidence item must be an object"];
  const o = v as Record<string, unknown>;
  const out: string[] = [];
  const extra = Object.keys(o).filter((k) => !(ITEM_KEYS as readonly string[]).includes(k));
  if (extra.length) out.push(`unsupported keys: ${extra.sort().join(", ")}`);
  for (const k of ITEM_KEYS) if (!Object.prototype.hasOwnProperty.call(o, k)) out.push(`${k} must be given${k === "timeZone" || k === "supersedes" ? " (null for none)" : ""}`);
  const str = (k: string) => typeof o[k] === "string" && (o[k] as string).trim() !== "" && (o[k] as string).trim() === o[k];

  if ("type" in o && !(EVIDENCE_TYPES as readonly unknown[]).includes(o.type)) out.push(`type must be one of ${EVIDENCE_TYPES.join(", ")}`);
  if ("contentSha256" in o && !isSha256Hex(o.contentSha256)) out.push("contentSha256 must be 64 lowercase hex characters");
  if ("byteSize" in o && !(typeof o.byteSize === "number" && Number.isSafeInteger(o.byteSize) && o.byteSize >= 0)) out.push("byteSize must be a non-negative safe integer");
  if ("mediaType" in o && !(typeof o.mediaType === "string" && MEDIA_TYPE.test(o.mediaType))) out.push("mediaType must be a lowercase type/subtype without parameters");
  if ("issuedAt" in o && !isRfc3339WithOffset(o.issuedAt)) out.push("issuedAt must be RFC 3339 with an offset");
  if ("recordedAt" in o && !isRfc3339WithOffset(o.recordedAt)) out.push("recordedAt must be RFC 3339 with an offset");
  if ("timeZone" in o && o.timeZone !== null && !isIanaTimeZone(o.timeZone)) out.push("timeZone must be an IANA time zone or null");
  for (const k of ["sourceId", "recordedBy", "retentionClassId"]) if (k in o && !str(k)) out.push(`${k} must be a non-empty string without surrounding whitespace`);
  if ("classification" in o && !(EVIDENCE_CLASSIFICATIONS as readonly unknown[]).includes(o.classification)) out.push(`classification must be one of ${EVIDENCE_CLASSIFICATIONS.join(", ")}`);
  if ("supersedes" in o && o.supersedes !== null) {
    if (!isSha256Hex(o.supersedes)) out.push("supersedes must be a content hash or null");
    else if (o.supersedes === o.contentSha256) out.push("an item cannot supersede itself");
  }
  return out;
}

export function assertEvidenceItem(v: unknown): asserts v is EvidenceItem {
  const p = evidenceItemProblems(v);
  if (p.length) throw new YieldEvidenceError("invalid_evidence", `invalid evidence item: ${p.join("; ")}`);
}

/** Checks that `bytes` are exactly the item's bytes (size and SHA-256); throws `integrity_mismatch` otherwise. */
export async function assertEvidenceBytes(item: EvidenceItem, bytes: Uint8Array): Promise<void> {
  assertEvidenceItem(item);
  if (!(bytes instanceof Uint8Array)) throw new YieldEvidenceError("invalid_evidence", "evidence bytes must be a Uint8Array");
  if (bytes.byteLength !== item.byteSize) throw new YieldEvidenceError("integrity_mismatch", "the bytes do not have the recorded size");
  if ((await contentHash(bytes)) !== item.contentSha256) throw new YieldEvidenceError("integrity_mismatch", "the bytes do not have the recorded SHA-256");
}

/** The manifest's order: type, then content hash, both in code-unit order. */
export function compareEvidenceItems(a: Pick<EvidenceItem, "type" | "contentSha256">, b: Pick<EvidenceItem, "type" | "contentSha256">): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.contentSha256 !== b.contentSha256) return a.contentSha256 < b.contentSha256 ? -1 : 1;
  return 0;
}

export interface EvidenceManifest {
  scheme: typeof EVIDENCE_MANIFEST_SCHEME;
  cycleId: string;
  cycleVersion: number;
  items: EvidenceItem[];
}

/**
 * The bundle manifest for a cycle version, with items in canonical order. Refuses invalid items and
 * duplicates (the same type and content hash twice). Does not decide whether superseded items stay in a
 * bundle: the caller passes the items the bundle contains.
 */
export function buildEvidenceManifest(m: { cycleId: string; cycleVersion: number; items: readonly EvidenceItem[] }): EvidenceManifest {
  if (!m || typeof m !== "object") throw new YieldEvidenceError("invalid_evidence", "a manifest needs a cycle and items");
  const extra = Object.keys(m).filter((k) => !["cycleId", "cycleVersion", "items"].includes(k));
  if (extra.length) throw new YieldEvidenceError("invalid_evidence", `unsupported keys: ${extra.sort().join(", ")}`);
  if (typeof m.cycleId !== "string" || m.cycleId.trim() === "" || m.cycleId.trim() !== m.cycleId) throw new YieldEvidenceError("invalid_evidence", "cycleId must be a non-empty string");
  if (!Number.isSafeInteger(m.cycleVersion) || m.cycleVersion < 1) throw new YieldEvidenceError("invalid_evidence", "cycleVersion must be an integer ≥ 1");
  if (!Array.isArray(m.items)) throw new YieldEvidenceError("invalid_evidence", "items must be a list");
  m.items.forEach(assertEvidenceItem);
  const items = [...m.items].sort(compareEvidenceItems);
  for (let i = 1; i < items.length; i++)
    if (compareEvidenceItems(items[i - 1]!, items[i]!) === 0) throw new YieldEvidenceError("duplicate_evidence", `evidence ${items[i]!.type} ${items[i]!.contentSha256} appears twice`);
  return { scheme: EVIDENCE_MANIFEST_SCHEME, cycleId: m.cycleId, cycleVersion: m.cycleVersion, items: items.map((x) => ({ ...x })) };
}

/** Canonical JSON of a manifest (rebuilt first, so order and validity never depend on the caller). */
export function canonicalEvidenceManifest(m: EvidenceManifest): string {
  if (m?.scheme !== EVIDENCE_MANIFEST_SCHEME) throw new YieldEvidenceError("invalid_evidence", `manifest scheme must be ${EVIDENCE_MANIFEST_SCHEME}`);
  const extra = Object.keys(m).filter((k) => !["scheme", "cycleId", "cycleVersion", "items"].includes(k));
  if (extra.length) throw new YieldEvidenceError("invalid_evidence", `unsupported keys: ${extra.sort().join(", ")}`);
  return canonicalJson(buildEvidenceManifest({ cycleId: m.cycleId, cycleVersion: m.cycleVersion, items: m.items }));
}

/** SHA-256 (lowercase hex) of the canonical manifest. */
export async function evidenceManifestHash(m: EvidenceManifest): Promise<string> {
  return contentHash(canonicalEvidenceManifest(m));
}
