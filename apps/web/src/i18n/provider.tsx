"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { UiTextProvider } from "@metafarm/ui";
import { dirOf, LOCALE_COOKIE, type Locale } from "./config";
import { makeFormat, type Format } from "./format";
import { en, type Messages } from "./messages/en";
import { fa } from "./messages/fa";

const MESSAGES: Record<Locale, Messages> = { en, fa };

interface I18n {
  locale: Locale;
  dir: "ltr" | "rtl";
  m: Messages;
  fmt: Format;
}

const I18nContext = createContext<I18n>({ locale: "en", dir: "ltr", m: en, fmt: makeFormat("en") });

/** Provides the request's language (decided on the server) to client components. */
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<I18n>(() => ({ locale, dir: dirOf(locale), m: MESSAGES[locale], fmt: makeFormat(locale) }), [locale]);
  return (
    <I18nContext.Provider value={value}>
      <UiTextProvider value={value.m.ui}>{children}</UiTextProvider>
    </I18nContext.Provider>
  );
}

export const useI18n = () => useContext(I18nContext);

/** Saves the choice for a year and reloads, so the server renders lang/dir and every screen in the new language. */
export function setLocale(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
  window.location.reload();
}
