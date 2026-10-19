import { describe, expect, it } from "vitest";
import { apiEnvSchema, docsEnabled, isDeployedEnvironment } from "./index";

describe("deployed environments", () => {
  it("are staging and production only", () => {
    expect(isDeployedEnvironment("staging")).toBe(true);
    expect(isDeployedEnvironment("production")).toBe(true);
    for (const e of ["development", "test", undefined, "", "Production"]) expect(isDeployedEnvironment(e)).toBe(false);
  });
});

describe("interactive API docs", () => {
  it("are off by default wherever the app is deployed, on elsewhere", () => {
    expect(docsEnabled({ APP_ENV: "staging" })).toBe(false);
    expect(docsEnabled({ APP_ENV: "production" })).toBe(false);
    expect(docsEnabled({ APP_ENV: "development" })).toBe(true);
    expect(docsEnabled({ APP_ENV: "test" })).toBe(true);
  });

  it("follow API_DOCS_ENABLED when it is set", () => {
    expect(docsEnabled({ APP_ENV: "staging", API_DOCS_ENABLED: true })).toBe(true);
    expect(docsEnabled({ APP_ENV: "development", API_DOCS_ENABLED: false })).toBe(false);
  });

  it("parse API_DOCS_ENABLED from the environment, leaving it unset when absent", () => {
    const base = { APP_ENV: "development", DATABASE_URL: "postgres://u:p@localhost:5432/db", REDIS_URL: "redis://localhost:6379" };
    expect(apiEnvSchema.parse(base).API_DOCS_ENABLED).toBeUndefined();
    expect(apiEnvSchema.parse({ ...base, API_DOCS_ENABLED: "true" }).API_DOCS_ENABLED).toBe(true);
    expect(apiEnvSchema.parse({ ...base, API_DOCS_ENABLED: "false" }).API_DOCS_ENABLED).toBe(false);
    expect(apiEnvSchema.safeParse({ ...base, API_DOCS_ENABLED: "yes" }).success).toBe(false);
  });
});
