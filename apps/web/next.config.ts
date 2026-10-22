import path from "node:path";
import type { NextConfig } from "next";

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

const config: NextConfig = {
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
