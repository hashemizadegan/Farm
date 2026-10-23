import { describe, expect, it } from "vitest";
import { apiDocsEnabled, apiEnvSchema } from "./index";

describe("API docs exposure", () => {
  it("is off by default once deployed, on in development and test", () => {
    expect(apiDocsEnabled({ APP_ENV: "staging" })).toBe(false);
    expect(apiDocsEnabled({ APP_ENV: "production" })).toBe(false);
    expect(apiDocsEnabled({ APP_ENV: "development" })).toBe(true);
    expect(apiDocsEnabled({ APP_ENV: "test" })).toBe(true);
  });

  it("follows an explicit setting either way", () => {
    expect(apiDocsEnabled({ APP_ENV: "staging", API_DOCS_ENABLED: true })).toBe(true);
    expect(apiDocsEnabled({ APP_ENV: "development", API_DOCS_ENABLED: false })).toBe(false);
  });

  it("reads API_DOCS_ENABLED from the environment, unset by default", () => {
    const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", REDIS_URL: "redis://localhost:6379" };
    expect(apiEnvSchema.parse(base).API_DOCS_ENABLED).toBeUndefined();
    expect(apiEnvSchema.parse({ ...base, API_DOCS_ENABLED: "true" }).API_DOCS_ENABLED).toBe(true);
    expect(apiEnvSchema.parse({ ...base, API_DOCS_ENABLED: "false" }).API_DOCS_ENABLED).toBe(false);
    expect(apiEnvSchema.safeParse({ ...base, API_DOCS_ENABLED: "yes" }).success).toBe(false);
  });
});

describe("yield workflow flag (Y9)", () => {
  const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", REDIS_URL: "redis://localhost:6379" };
  it("is off by default and can be turned on outside production", () => {
    expect(apiEnvSchema.parse(base).YIELD_WORKFLOW_ENABLED).toBe(false);
    expect(apiEnvSchema.parse(base).MARKETPLACE_ENABLED).toBe(false);
    expect(apiEnvSchema.parse({ ...base, APP_ENV: "test", MARKETPLACE_ENABLED: "true" }).MARKETPLACE_ENABLED).toBe(true);
    expect(JSON.stringify(apiEnvSchema.safeParse({ ...base, APP_ENV: "production", AUTH_PROVIDER: "oidc", STORAGE_DRIVER: "s3", MARKETPLACE_ENABLED: "true" }).error?.issues)).toContain("MARKETPLACE_ENABLED");
    expect(apiEnvSchema.parse({ ...base, APP_ENV: "test", YIELD_WORKFLOW_ENABLED: "true" }).YIELD_WORKFLOW_ENABLED).toBe(true);
  });
  it("is refused in production (simulation-only, not approved)", () => {
    const r = apiEnvSchema.safeParse({ ...base, APP_ENV: "production", AUTH_PROVIDER: "oidc", STORAGE_DRIVER: "s3", YIELD_WORKFLOW_ENABLED: "true" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("YIELD_WORKFLOW_ENABLED");
  });
});

describe("party links flag (Y12)", () => {
  const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", REDIS_URL: "redis://localhost:6379" };
  it("is off by default and refused in production", () => {
    expect(apiEnvSchema.parse(base).PARTY_LINKS_ENABLED).toBe(false);
    const r = apiEnvSchema.safeParse({ ...base, APP_ENV: "production", AUTH_PROVIDER: "oidc", STORAGE_DRIVER: "s3", PARTY_LINKS_ENABLED: "true" });
    expect(JSON.stringify(r.error?.issues)).toContain("PARTY_LINKS_ENABLED");
  });
});

describe("holder yield flag (Y13)", () => {
  const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", REDIS_URL: "redis://localhost:6379" };
  it("is off by default and refused in staging and production", () => {
    expect(apiEnvSchema.parse(base).HOLDER_YIELD_ENABLED).toBe(false);
    for (const APP_ENV of ["staging", "production"]) {
      const r = apiEnvSchema.safeParse({ ...base, APP_ENV, AUTH_PROVIDER: "oidc", STORAGE_DRIVER: "s3", HOLDER_YIELD_ENABLED: "true" });
      expect(JSON.stringify(r.error?.issues)).toContain("HOLDER_YIELD_ENABLED");
    }
  });
});

describe("claim intents flag (Y13)", () => {
  const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", REDIS_URL: "redis://localhost:6379" };
  it("is off by default and refused in staging and production", () => {
    expect(apiEnvSchema.parse(base).YIELD_CLAIM_INTENTS_ENABLED).toBe(false);
    for (const APP_ENV of ["staging", "production"]) {
      const r = apiEnvSchema.safeParse({ ...base, APP_ENV, AUTH_PROVIDER: "oidc", STORAGE_DRIVER: "s3", YIELD_CLAIM_INTENTS_ENABLED: "true" });
      expect(JSON.stringify(r.error?.issues)).toContain("YIELD_CLAIM_INTENTS_ENABLED");
    }
  });
});

describe("deployed development configuration needs the preview access gate", () => {
  const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", REDIS_URL: "redis://localhost:6379" };
  const railway = { RAILWAY_PROJECT_ID: "00000000-0000-4000-8000-000000000000" };

  it("refuses development or test on the platform without PREVIEW_ACCESS_GATE", () => {
    for (const APP_ENV of ["development", "test"]) {
      const r = apiEnvSchema.safeParse({ ...base, ...railway, APP_ENV });
      expect(r.success, APP_ENV).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("PREVIEW_ACCESS_GATE");
      expect(apiEnvSchema.safeParse({ ...base, ...railway, APP_ENV, PREVIEW_ACCESS_GATE: "false" }).success).toBe(false);
    }
  });

  it("accepts it with the gate on", () => {
    expect(apiEnvSchema.parse({ ...base, ...railway, APP_ENV: "development", PREVIEW_ACCESS_GATE: "true" }).PREVIEW_ACCESS_GATE).toBe(true);
  });

  it("changes nothing off the platform (local development, CI)", () => {
    expect(apiEnvSchema.parse({ ...base, APP_ENV: "development" }).PREVIEW_ACCESS_GATE).toBe(false);
  });

  it("changes nothing for deployed staging or production", () => {
    const deployed = { ...base, ...railway, AUTH_PROVIDER: "oidc", STORAGE_DRIVER: "s3" };
    expect(apiEnvSchema.safeParse({ ...deployed, APP_ENV: "staging" }).success).toBe(true);
    expect(apiEnvSchema.safeParse({ ...deployed, APP_ENV: "production" }).success).toBe(true);
  });
});
