import { defineConfig } from "vitest/config";

/**
 * Root Vitest configuration.
 *
 * - `unit` runs everywhere with no external services.
 * - `unit-shared-cycle` runs the large-holder yield tests in one non-isolated process so they share a memoized
 *   cycle; `test:unit` runs it together with `unit`.
 * - `integration` needs PostgreSQL+PostGIS and Redis (see docker-compose.yml)
 *   and is skipped automatically when DATABASE_URL is not set.
 */
/** Run in the `unit-shared-cycle` project (and excluded from `unit`), so they share one cycle build. */
const SHARED_CYCLE_TESTS = ["packages/domain/src/yield/large-holder-envelope.test.ts", "packages/domain/src/yield/claim-read-model.test.ts"];

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
          exclude: ["**/*.int.test.ts", "**/node_modules/**", ...SHARED_CYCLE_TESTS],
          environment: "node",
        },
      },
      {
        // Unit tests that reuse one deterministic 16,384-holder simulation cycle, memoized in-process
        // (packages/domain/src/yield/large-holder.test-support.ts). They run in one process without module
        // isolation so the memo is shared; they are pure (no files, databases or network).
        test: {
          name: "unit-shared-cycle",
          include: SHARED_CYCLE_TESTS,
          environment: "node",
          pool: "forks",
          isolate: false,
          poolOptions: { forks: { singleFork: true, isolate: false } },
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
