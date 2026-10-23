import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../.env"));
} catch {
  /* CI provides the environment directly */
}

/**
 * End-to-end tests run against the full local stack:
 *   docker compose up -d   (PostGIS, Redis, MinIO)
 *   pnpm db:migrate && pnpm db:seed
 *   API, worker and web are started by `webServer` below.
 */
const WEB = process.env.E2E_WEB_URL ?? "http://localhost:3000";
const API = process.env.E2E_API_URL ?? "http://localhost:4000";
const reuse = !process.env.CI;

/**
 * Remote mode (E2E_REMOTE=1): run the same suite against an already deployed, isolated preview (E2E_WEB_URL,
 * E2E_API_URL). No local servers are started and nothing is seeded from here (the preview's seed runner did that).
 * Dev tokens are minted locally from DEV_AUTH_SECRET (the preview's value), as in local runs.
 */
const REMOTE = process.env.E2E_REMOTE === "1";
/** HTTP Basic password of a gated web app (the preview's PREVIEW_ACCESS_PASSWORD); sent to the web origin only. */
const GATE_PASSWORD = process.env.E2E_PREVIEW_ACCESS_PASSWORD;
/**
 * Local/CI only: a second web server on this URL with the preview access gate ON (same build), so the gate is
 * exercised end to end in a real Next.js server (tests/e2e/preview-gate.spec.ts).
 */
const GATED_WEB = !REMOTE ? process.env.E2E_GATED_WEB_URL : undefined;

const env = (extra: Record<string, string>): Record<string, string> => ({
  ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>),
  ...extra,
});

const localServers = [
  {
    command: "pnpm --filter @metafarm/api dev",
    url: `${API}/healthz`,
    reuseExistingServer: reuse,
    cwd: "..",
    timeout: 120_000,
  },
  {
    command: "pnpm --filter @metafarm/worker dev",
    // The worker has no HTTP UI; its health server doubles as readiness.
    url: "http://localhost:4100/healthz",
    reuseExistingServer: reuse,
    cwd: "..",
    timeout: 120_000,
  },
  {
    command: process.env.CI ? "pnpm --filter @metafarm/web start" : "pnpm --filter @metafarm/web dev",
    url: WEB,
    reuseExistingServer: reuse,
    cwd: "..",
    timeout: 180_000,
  },
  ...(GATED_WEB && GATE_PASSWORD
    ? [
        {
          command: "pnpm --filter @metafarm/web start",
          // Readiness through the one path the gate serves without credentials.
          url: `${GATED_WEB}/healthz`,
          reuseExistingServer: reuse,
          cwd: "..",
          timeout: 180_000,
          env: env({ PORT: new URL(GATED_WEB).port, PREVIEW_ACCESS_GATE: "true", PREVIEW_ACCESS_PASSWORD: GATE_PASSWORD }),
        },
      ]
    : []),
];

/**
 * What a remote run exercises: the preview's own surface (the access gate, the /yield operator pages and the farm
 * operations journey over the seeded simulation data). The preview is not a general test bed, so the rest of the suite
 * (which creates farms, uploads and jobs) stays local unless E2E_REMOTE_ALL=1 asks for it explicitly.
 */
const REMOTE_SPECS = ["preview-gate.spec.ts", "yield-operator.spec.ts", "preview-journey.spec.ts", "preview-live.spec.ts", "preview-screens.spec.ts", "marketplace-journey.spec.ts"];

export default defineConfig({
  testDir: "./e2e",
  ...(REMOTE && process.env.E2E_REMOTE_ALL !== "1" ? { testMatch: REMOTE_SPECS } : {}),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: WEB,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: process.env.CI ? "retain-on-failure" : "off",
    // A gated preview asks every browser request for Basic credentials; never send them to any other origin.
    ...(REMOTE && GATE_PASSWORD ? { httpCredentials: { username: "preview", password: GATE_PASSWORD, origin: new URL(WEB).origin, send: "always" as const } } : {}),
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: REMOTE ? [] : localServers,
});
