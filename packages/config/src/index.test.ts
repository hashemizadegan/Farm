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
