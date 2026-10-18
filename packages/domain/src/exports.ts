/**
 * Spreadsheet exports (CSV). Values stay machine-readable — ISO dates, Latin digits, a dot for
 * decimals — so they sort and sum correctly in any spreadsheet; only the column headings follow
 * the reader's language. A UTF-8 byte-order mark makes Excel read Persian text correctly.
 */
import { z } from "zod";
import { taskDateSchema as isoDate } from "./tasks";

export const EXPORT_DATASETS = ["input-log", "harvests", "tasks", "stock"] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];
export const EXPORT_LANGS = ["en", "fa"] as const;
export type ExportLang = (typeof EXPORT_LANGS)[number];
/** Rows per file; well above a season for one workspace. */
export const EXPORT_MAX_ROWS = 50_000;

export const exportQuerySchema = z
  .object({
    farmId: z.string().uuid().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    lang: z.enum(EXPORT_LANGS).default("en"),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from must not be after to", path: ["from"] });

export type Cell = string | number | boolean | null | undefined;

const NUMBER = /^-?\d+(\.\d+)?$/;

/** One CSV field (RFC 4180), neutralising text a spreadsheet would run as a formula. */
export function csvField(v: Cell): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v !== "number" && !NUMBER.test(s) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A whole file: byte-order mark, header row, CRLF line endings. */
export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const lines = [header, ...rows].map((r) => r.map(csvField).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function exportFilename(dataset: ExportDataset, q: { from?: string; to?: string }, today: string): string {
  return `${dataset}_${q.from ?? "start"}_${q.to ?? today}.csv`;
}

type Headers = Record<ExportDataset, readonly string[]>;

export const EXPORT_COLUMNS: Record<ExportLang, Headers> = {
  en: {
    "input-log": ["Date", "Farm", "Parcel", "Product", "Category", "Quantity", "Unit", "Lot", "Pre-harvest interval (days)", "Task", "Recorded by", "Note"],
    harvests: ["Label code", "Harvested on", "Farm", "Crop", "Parcel", "Quantity", "Unit", "Grade", "Recorded by", "Fingerprint (SHA-256)", "Registry status", "Transaction", "Voided", "Void reason"],
    tasks: ["Due", "Farm", "Task", "Kind", "Parcel", "Priority", "Status", "Assigned to", "Repeats every (days)", "Completed at", "Completed by", "Completion note"],
    stock: ["Input", "Category", "Unit", "On hand", "Reorder level", "Low", "Pre-harvest interval (days)", "Re-entry (hours)", "Last movement", "Archived"],
  },
  fa: {
    "input-log": ["تاریخ", "مزرعه", "قطعه", "محصول", "دسته", "مقدار", "واحد", "سری ساخت", "فاصله تا برداشت (روز)", "کار", "ثبت‌کننده", "یادداشت"],
    harvests: ["کد برچسب", "تاریخ برداشت", "مزرعه", "محصول", "قطعه", "مقدار", "واحد", "درجه", "ثبت‌کننده", "اثر انگشت (SHA-256)", "وضعیت ثبت", "تراکنش", "باطل‌شده", "دلیل ابطال"],
    tasks: ["سررسید", "مزرعه", "کار", "نوع", "قطعه", "اولویت", "وضعیت", "مسئول", "تکرار هر (روز)", "زمان انجام", "انجام‌دهنده", "یادداشت انجام"],
    stock: ["نهاده", "دسته", "واحد", "موجودی", "حد سفارش", "کم", "فاصله تا برداشت (روز)", "ورود مجدد (ساعت)", "آخرین جابه‌جایی", "بایگانی‌شده"],
  },
};

/** Yes/no cells in the reader's language. */
export const yesNo = (lang: ExportLang, v: boolean): string => (lang === "fa" ? (v ? "بله" : "خیر") : v ? "yes" : "no");

/** Drops a numeric's trailing zeros ("2.500" → "2.5") and, when asked, its sign. */
export function plainNumber(n: string | null | undefined, abs = false): string {
  if (n === null || n === undefined) return "";
  let s = n.includes(".") ? n.replace(/0+$/, "").replace(/\.$/, "") : n;
  if (abs && s.startsWith("-")) s = s.slice(1);
  return s;
}
