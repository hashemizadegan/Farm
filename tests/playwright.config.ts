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

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: WEB,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
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
  ],
});
