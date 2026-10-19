/** The down-migration guard (no database needed). */
import { describe, expect, it } from "vitest";
import { downMigrationRefusal } from "./migrate";

describe("down migrations", () => {
  it("are refused in staging and production", () => {
    expect(downMigrationRefusal({ APP_ENV: "staging" })).toMatch(/blocked in staging/);
    expect(downMigrationRefusal({ APP_ENV: "production" })).toMatch(/blocked in production/);
    // Only the exact opt-in unlocks them.
    expect(downMigrationRefusal({ APP_ENV: "staging", ALLOW_DESTRUCTIVE_MIGRATIONS: "1" })).not.toBeNull();
    expect(downMigrationRefusal({ APP_ENV: "production", ALLOW_DESTRUCTIVE_MIGRATIONS: "TRUE" })).not.toBeNull();
  });

  it("run with an explicit opt-in for that run", () => {
    expect(downMigrationRefusal({ APP_ENV: "staging", ALLOW_DESTRUCTIVE_MIGRATIONS: "true" })).toBeNull();
    expect(downMigrationRefusal({ APP_ENV: "production", ALLOW_DESTRUCTIVE_MIGRATIONS: "true" })).toBeNull();
  });

  it("run freely in development and test", () => {
    expect(downMigrationRefusal({ APP_ENV: "development" })).toBeNull();
    expect(downMigrationRefusal({ APP_ENV: "test" })).toBeNull();
    expect(downMigrationRefusal({})).toBeNull();
  });
});
