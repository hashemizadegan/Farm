"use client";
import { LOCALES } from "@/i18n/config";
import { setLocale, useI18n } from "@/i18n/provider";

/** English ⇄ فارسی. Each option is written in its own language and marked with its lang so screen readers pronounce it correctly. */
export function LanguageSwitch({ className }: { className?: string }) {
  const { locale, m } = useI18n();
  return (
    <div role="group" aria-label={m.lang.label} className={["lang-switch", className].filter(Boolean).join(" ")}>
      {LOCALES.map((l) => (
        <button key={l} type="button" lang={l} aria-pressed={l === locale} onClick={() => l !== locale && setLocale(l)}>
          {m.lang[l]}
        </button>
      ))}
    </div>
  );
}
