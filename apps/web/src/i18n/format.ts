import type { Locale } from "./config";

/**
 * Locale-aware formatting. Persian uses Persian digits and the Solar Hijri
 * calendar (the default calendar for fa-IR). Coordinates are not formatted
 * here: they stay in Latin digits so they can be copied into GIS tools.
 */
export function makeFormat(locale: Locale) {
  const tag = locale === "fa" ? "fa-IR" : "en-GB";
  const date = new Intl.DateTimeFormat(tag, { dateStyle: "medium" });
  const dateTime = new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" });
  const nf = (o?: Intl.NumberFormatOptions) => new Intl.NumberFormat(tag, o);
  const unit = locale === "fa" ? { ha: "هکتار", m2: "متر مربع", bytes: "بایت", kb: "کیلوبایت", mb: "مگابایت" } : { ha: "ha", m2: "m²", bytes: "bytes", kb: "KB", mb: "MB" };

  return {
    tag,
    unitHa: unit.ha,
    date: (iso: string) => date.format(new Date(iso)),
    dateTime: (iso: string) => dateTime.format(new Date(iso)),
    number: (n: number, o?: Intl.NumberFormatOptions) => nf(o).format(n),
    /** Fixed decimals, localised digits. */
    fixed: (n: number, digits: number) => nf({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n),
    currency: (n: number, currency: string) => nf({ style: "currency", currency, maximumFractionDigits: 0 }).format(n),
    /** Area in hectares, to a sensible precision for the size. */
    ha: (m2: number) => {
      const ha = m2 / 10_000;
      const digits = ha < 10 ? 2 : ha < 100 ? 1 : 0;
      return `${nf({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(ha)} ${unit.ha}`;
    },
    m2: (m2: number) => `${nf({ maximumFractionDigits: 0 }).format(Math.round(m2))} ${unit.m2}`,
    size: (bytes: number) => {
      if (bytes < 1024) return `${nf().format(bytes)} ${unit.bytes}`;
      if (bytes < 1024 * 1024) return `${nf({ maximumFractionDigits: 0 }).format(bytes / 1024)} ${unit.kb}`;
      return `${nf({ minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} ${unit.mb}`;
    },
    /** A list joined with the language's "and" / comma. */
    list: (items: string[]) => new Intl.ListFormat(tag, { style: "long", type: "conjunction" }).format(items),
  };
}

export type Format = ReturnType<typeof makeFormat>;
