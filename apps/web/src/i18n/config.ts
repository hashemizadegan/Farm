/** Supported interface languages. Persian ("fa") is written right-to-left. */
export const LOCALES = ["en", "fa"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
/** Cookie holding the user's explicit choice; read by the server so the first HTML already has lang and dir. */
export const LOCALE_COOKIE = "mf_locale";

export const isLocale = (v: unknown): v is Locale => v === "en" || v === "fa";
export const dirOf = (l: Locale): "ltr" | "rtl" => (l === "fa" ? "rtl" : "ltr");

/** The saved choice wins; otherwise the first supported language in Accept-Language; otherwise English. */
export function negotiateLocale(cookie: string | undefined | null, acceptLanguage: string | undefined | null): Locale {
  if (isLocale(cookie)) return cookie;
  for (const part of (acceptLanguage ?? "").split(",")) {
    const tag = part.split(";")[0]!.trim().toLowerCase();
    if (tag === "fa" || tag.startsWith("fa-")) return "fa";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return DEFAULT_LOCALE;
}
