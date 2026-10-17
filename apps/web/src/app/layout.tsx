import "@metafarm/ui/styles.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./app.css";
import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible, Familjen_Grotesk, Vazirmatn } from "next/font/google";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { dirOf } from "@/i18n/config";
import { en } from "@/i18n/messages/en";
import { fa } from "@/i18n/messages/fa";
import { I18nProvider } from "@/i18n/provider";
import { getLocale } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const m = (await getLocale()) === "fa" ? fa : en;
  return { title: { default: m.meta.title, template: `%s · ${m.meta.title}` }, description: m.meta.description };
}

// Self-hosted at build time by next/font, so no third-party font requests (CSP font-src 'self').
// Atkinson Hyperlegible: designed for legibility (distinct letterforms), which suits reading in the field.
const body = Atkinson_Hyperlegible({ subsets: ["latin", "latin-ext"], variable: "--font-body", display: "swap", weight: ["400", "700"] });
const display = Familjen_Grotesk({ subsets: ["latin", "latin-ext"], variable: "--font-display", display: "swap", weight: ["600", "700"] });
// Persian: Vazirmatn, a widely used open-source Persian typeface with matching Latin. Used only when lang="fa" (see app.css).
const persian = Vazirmatn({ subsets: ["arabic", "latin"], variable: "--font-fa", display: "swap", weight: ["400", "500", "700"], preload: false });

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

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
