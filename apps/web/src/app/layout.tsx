import "@metafarm/ui/styles.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./app.css";
import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible, Familjen_Grotesk } from "next/font/google";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: { default: "Metafarm", template: "%s · Metafarm" },
  description: "Plan farm projects on a map and explore them in an illustrative 3D scene.",
};

// Self-hosted at build time by next/font, so no third-party font requests (CSP font-src 'self').
// Atkinson Hyperlegible: designed for legibility (distinct letterforms), which suits reading in the field.
const body = Atkinson_Hyperlegible({ subsets: ["latin", "latin-ext"], variable: "--font-body", display: "swap", weight: ["400", "700"] });
const display = Familjen_Grotesk({ subsets: ["latin", "latin-ext"], variable: "--font-display", display: "swap", weight: ["600", "700"] });

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading request headers makes every page dynamic, which is required for the
  // per-request CSP nonce (middleware.ts) to be applied to Next's inline scripts.
  await headers();
  return (
    <html lang="en" className={`${body.variable} ${display.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
