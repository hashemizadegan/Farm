import path from "node:path";
import type { NextConfig } from "next";
// Relative path: next.config.ts is compiled on its own, before workspace packages are transpiled for the app.
import { assertCapabilities, webCapabilities } from "../../packages/config/src/capabilities";

// Share the monorepo's root .env in local development (Next only reads apps/web/.env* by default).
try {
  process.loadEnvFile(path.resolve(process.cwd(), "../../.env"));
} catch {
  /* no root .env (CI, Docker): rely on the real environment */
}

// Y10: the internal yield pages are refused in deployed builds until a disclosure version is approved (D-39).
// Same rule as yieldPagesBuildProblem (src/lib/yield.ts), kept inline so the config has no app imports.
if (process.env.NEXT_PUBLIC_YIELD_PAGES_ENABLED === "true" && (process.env.APP_ENV === "staging" || process.env.APP_ENV === "production")) {
  throw new Error("NEXT_PUBLIC_YIELD_PAGES_ENABLED is refused in deployed environments until a disclosure version is approved (D-39)");
}

// Marketplace (simulation only): refused in production builds until the owner approves a rollout. Same rule as
// marketplaceBuildProblem (src/lib/market.ts).
if (process.env.NEXT_PUBLIC_MARKETPLACE_ENABLED === "true" && process.env.APP_ENV === "production") {
  throw new Error("NEXT_PUBLIC_MARKETPLACE_ENABLED is refused in production: the marketplace is simulation-only and needs the owner's approval before a production rollout");
}

// Provider capabilities (packages/config capabilities.ts, the same rules the API and worker apply at start-up): map
// tiles (https style, attribution, CSP host), globe imagery, browser media uploads and the realtime channel URL. NEXT_PUBLIC_* values are inlined
// at build time, so an enabled provider with incomplete or unsafe configuration fails the build (fail closed); the
// error names variables, never values. The result is passed to the bundle, so the runtime uses exactly what passed.
const webProviders = assertCapabilities(
  webCapabilities({
    APP_ENV: process.env.APP_ENV,
    NEXT_PUBLIC_MAP_STYLE_URL: process.env.NEXT_PUBLIC_MAP_STYLE_URL,
    NEXT_PUBLIC_MAP_ATTRIBUTION: process.env.NEXT_PUBLIC_MAP_ATTRIBUTION,
    NEXT_PUBLIC_MAP_CONNECT_SRC: process.env.NEXT_PUBLIC_MAP_CONNECT_SRC,
    NEXT_PUBLIC_CESIUM_ENABLED: process.env.NEXT_PUBLIC_CESIUM_ENABLED,
    NEXT_PUBLIC_UPLOAD_CONNECT_SRC: process.env.NEXT_PUBLIC_UPLOAD_CONNECT_SRC,
    NEXT_PUBLIC_REALTIME_URL: process.env.NEXT_PUBLIC_REALTIME_URL,
  }),
);
const providerState = (name: string) => webProviders.find((r) => r.capability === name)?.state ?? "disabled";

const config: NextConfig = {
  env: {
    NEXT_PUBLIC_MAP_TILES_STATE: providerState("map-tiles"),
    NEXT_PUBLIC_REALTIME_STATE: providerState("realtime"),
  },
  // Standalone output produces a minimal server bundle for the Docker image.
  output: "standalone",
  // Monorepo root, so standalone output includes workspace packages. `next` runs with cwd = apps/web.
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@metafarm/contracts", "@metafarm/domain", "@metafarm/map-scene", "@metafarm/ui"],
  async headers() {
    // CSP is set per request in middleware.ts (it needs a nonce); these are static.
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default config;
