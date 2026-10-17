import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, negotiateLocale, type Locale } from "./config";

/** The request's interface language (server components only). */
export async function getLocale(): Promise<Locale> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  return negotiateLocale(c.get(LOCALE_COOKIE)?.value, h.get("accept-language"));
}
