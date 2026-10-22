import { describe, expect, it } from "vitest";
import { PREVIEW_SEED_MIN_MIGRATION, previewSeedRefusal } from "./preview-seed-guard";

const ok = { appEnv: "development", tenantSlugs: [] as string[], latestMigration: "0029_yield_claim_intent_batches" };

describe("preview seed guard", () => {
  it("accepts a fresh, migrated database in development or test", () => {
    expect(previewSeedRefusal(ok)).toBeNull();
    expect(previewSeedRefusal({ ...ok, appEnv: "test" })).toBeNull();
    expect(previewSeedRefusal({ ...ok, tenantSlugs: ["demo"] })).toBeNull(); // a re-run after seeding
    expect(previewSeedRefusal({ ...ok, latestMigration: "0031_later" })).toBeNull();
  });

  it("refuses every APP_ENV outside the allow-list, unset included", () => {
    for (const appEnv of ["production", "staging", "preview", "Development", "", undefined]) {
      expect(previewSeedRefusal({ ...ok, appEnv }), String(appEnv)).toMatch(/APP_ENV must be development or test/);
    }
  });

  it("refuses a database with any workspace other than the demo one", () => {
    expect(previewSeedRefusal({ ...ok, tenantSlugs: ["demo", "acme"] })).toMatch(/not a fresh, isolated preview database/);
    expect(previewSeedRefusal({ ...ok, tenantSlugs: ["acme"] })).toMatch(/1 workspace/);
  });

  it("refuses an unmigrated or under-migrated database", () => {
    expect(PREVIEW_SEED_MIN_MIGRATION).toBe("0029");
    expect(previewSeedRefusal({ ...ok, latestMigration: null })).toMatch(/through 0029/);
    expect(previewSeedRefusal({ ...ok, latestMigration: "0018_cnft_leaf" })).toMatch(/latest: 0018_cnft_leaf/);
    expect(previewSeedRefusal({ ...ok, latestMigration: "0028_yield_carry_ledgers" })).toMatch(/through 0029/);
  });

  it("checks the environment before anything about the database", () => {
    expect(previewSeedRefusal({ appEnv: "production", tenantSlugs: ["acme"], latestMigration: null })).toMatch(/APP_ENV/);
  });
});
