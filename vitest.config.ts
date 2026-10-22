import { defineConfig } from "vitest/config";

/**
 * Root Vitest configuration.
 *
 * - `unit` runs everywhere with no external services.
 * - `integration` needs PostgreSQL+PostGIS and Redis (see docker-compose.yml)
 *   and is skipped automatically when DATABASE_URL is not set.
 */
export default defineConfig({
  // UI and scene packages use the automatic JSX runtime.
  esbuild: { jsx: "automatic" },
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "packages/*/src/**/*.test.ts",
            "packages/*/src/**/*.test.tsx",
            "apps/*/src/**/*.test.ts",
          ],
          exclude: ["**/*.int.test.ts", "**/node_modules/**"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["packages/*/src/**/*.int.test.ts", "apps/*/src/**/*.int.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
