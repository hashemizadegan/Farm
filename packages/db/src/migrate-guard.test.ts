import { describe, expect, it } from "vitest";
import { downMigrationBlocked } from "./migrate";

describe("down migrations", () => {
  it("are blocked in staging and production unless deliberately allowed", () => {
    expect(downMigrationBlocked({ APP_ENV: "staging" })).toMatch(/blocked in staging/);
    expect(downMigrationBlocked({ APP_ENV: "production" })).toMatch(/blocked in production/);
    expect(downMigrationBlocked({ APP_ENV: "production", ALLOW_DESTRUCTIVE_MIGRATIONS: "1" })).not.toBeNull();
    expect(downMigrationBlocked({ APP_ENV: "staging", ALLOW_DESTRUCTIVE_MIGRATIONS: "true" })).toBeNull();
  });

  it("are allowed in development and test, and when APP_ENV is unset", () => {
    expect(downMigrationBlocked({ APP_ENV: "development" })).toBeNull();
    expect(downMigrationBlocked({ APP_ENV: "test" })).toBeNull();
    expect(downMigrationBlocked({})).toBeNull();
  });
});
