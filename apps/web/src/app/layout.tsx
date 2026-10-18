import "@metafarm/ui/styles.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./app.css";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { dirOf } from "@/i18n/config";
import { en } from "@/i18n/messages/en";
import { fa } from "@/i18n/messages/fa";
import { I18nProvider } from "@/i18n/provider";
import { getLocale } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const m = (await getLocale()) === "fa" ? fa : en;
  return {
    title: { default: m.meta.title, template: `%s · ${m.meta.title}` },
    description: m.meta.description,
    appleWebApp: { capable: true, title: m.meta.title, statusBarStyle: "default" },
    icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
  };
}

// Bundled from the Fontsource packages (open-licensed copies of the Google Fonts releases) and served
// by next/font from our own origin: no third-party requests at runtime (CSP font-src 'self') and none
// at build time, where fetching from Google failed intermittently. (Paths must be literals.)
// Atkinson Hyperlegible: designed for legibility (distinct letterforms), which suits reading in the field.
const body = localFont({
  src: [
    { path: "../../node_modules/@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../node_modules/@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-body",
  display: "swap",
});
const display = localFont({
  src: [
    { path: "../../node_modules/@fontsource/familjen-grotesk/files/familjen-grotesk-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../../node_modules/@fontsource/familjen-grotesk/files/familjen-grotesk-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-display",
  display: "swap",
});
// Persian: Vazirmatn, a widely used open-source Persian typeface. Used only when lang="fa" (see app.css);
// Latin text inside Persian pages falls back to the body font.
const persian = localFont({
  src: [
    { path: "../../node_modules/@fontsource/vazirmatn/files/vazirmatn-arabic-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../node_modules/@fontsource/vazirmatn/files/vazirmatn-arabic-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../../node_modules/@fontsource/vazirmatn/files/vazirmatn-arabic-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-fa",
  display: "swap",
  preload: false,
});

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#173323" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading the request (cookie and Accept-Language) makes every page dynamic, which is also required
  // for the per-request CSP nonce (middleware.ts) to be applied to Next's inline scripts.
  const locale = await getLocale();
  return (
    <html lang={locale} dir={dirOf(locale)} className={`${body.variable} ${display.variable} ${persian.variable}`}>
      <body>
        <I18nProvider locale={locale}>
          <AppShell>{children}</AppShell>
        </I18nProvider>
      </body>
    </html>
  );
}
