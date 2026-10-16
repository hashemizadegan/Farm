import "@metafarm/ui/styles.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./app.css";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: { default: "Metafarm", template: "%s · Metafarm" },
  description: "Plan farm projects on a map and explore them in an illustrative 3D scene.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading request headers makes every page dynamic, which is required for the
  // per-request CSP nonce (middleware.ts) to be applied to Next's inline scripts.
  await headers();
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
