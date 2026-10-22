import { describe, expect, it } from "vitest";
import { DEV_SEED_TENANT_SLUGS, PREVIEW_SEED_MIN_MIGRATION, previewSeedRefusal } from "./preview-seed-guard";

const ok = { appEnv: "development", tenantSlugs: [] as string[], nonDevUsers: 0, latestMigration: "0029_yield_claim_intent_batches" };

describe("preview seed guard", () => {
  it("accepts a fresh, migrated database in development or test", () => {
    expect(previewSeedRefusal(ok)).toBeNull();
    expect(previewSeedRefusal({ ...ok, appEnv: "test" })).toBeNull();
    // A re-run after seeding finds the development seed's own workspaces.
    expect(DEV_SEED_TENANT_SLUGS).toEqual(["demo", "other"]);
    expect(previewSeedRefusal({ ...ok, tenantSlugs: ["demo", "other"] })).toBeNull();
    expect(previewSeedRefusal({ ...ok, latestMigration: "0031_later" })).toBeNull();
  });

  it("refuses every APP_ENV outside the allow-list, unset included", () => {
    for (const appEnv of ["production", "staging", "preview", "Development", "", undefined]) {
      expect(previewSeedRefusal({ ...ok, appEnv }), String(appEnv)).toMatch(/APP_ENV must be development or test/);
    }
  });

  it("refuses a database with any workspace the development seed did not create", () => {
    expect(previewSeedRefusal({ ...ok, tenantSlugs: ["demo", "other", "acme"] })).toMatch(/not a fresh, isolated preview database/);
    expect(previewSeedRefusal({ ...ok, tenantSlugs: ["acme"] })).toMatch(/1 workspace/);
  });

  it("refuses a database with users from a real identity provider, whatever the workspaces are called", () => {
    expect(previewSeedRefusal({ ...ok, tenantSlugs: ["demo"], nonDevUsers: 1 })).toMatch(/1 user\(s\) from a real identity provider/);
  });

  it("refuses an unmigrated or under-migrated database", () => {
    expect(PREVIEW_SEED_MIN_MIGRATION).toBe("0029");
    expect(previewSeedRefusal({ ...ok, latestMigration: null })).toMatch(/through 0029/);
    expect(previewSeedRefusal({ ...ok, latestMigration: "0018_cnft_leaf" })).toMatch(/latest: 0018_cnft_leaf/);
    expect(previewSeedRefusal({ ...ok, latestMigration: "0028_yield_carry_ledgers" })).toMatch(/through 0029/);
  });

  it("checks the environment before anything about the database", () => {
    expect(previewSeedRefusal({ appEnv: "production", tenantSlugs: ["acme"], nonDevUsers: 5, latestMigration: null })).toMatch(/APP_ENV/);
  });
});
