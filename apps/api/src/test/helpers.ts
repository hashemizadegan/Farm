import { apiEnvSchema } from "@metafarm/config";
import type { Pool } from "@metafarm/db";
import { createLogger } from "@metafarm/observability";
import { buildApp } from "../app";
import { createDevProvider, mintDevToken } from "../auth/dev";
import type { Deps } from "../deps";
import type { RealtimeLimits } from "../routes/realtime";
import { createMemoryProducer } from "../queue/producer";
import { createMemoryStorage } from "@metafarm/storage";

export const DEV_SECRET = "test-secret-test-secret-test-secret-0000";

export function testEnv(overrides: Record<string, string> = {}) {
  return apiEnvSchema.parse({
    APP_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgres://unused:unused@127.0.0.1:1/unused",
    REDIS_URL: "redis://127.0.0.1:6379",
    DEV_AUTH_SECRET: DEV_SECRET,
    CORS_ORIGINS: "http://localhost:3000",
    WEBHOOK_SIGNING_SECRETS: "whsec_test",
    WALLET_AUTH_DOMAIN: "localhost:3000",
    WALLET_AUTH_URI: "http://localhost:3000",
    ...overrides,
  });
}

/** A pool that fails every query; proves a code path never reached the database. */
export function unreachablePool(): Pool {
  const fail = async () => {
    throw new Error("database should not be reached in this test");
  };
  return { query: fail, connect: fail, end: async () => undefined } as unknown as Pool;
}

export async function buildTestApp(opts: { pool: Pool; env?: Record<string, string>; deps?: Partial<Deps>; isDraining?: () => boolean; realtime?: Partial<RealtimeLimits> }) {
  const jobs = createMemoryProducer();
  const storage = createMemoryStorage();
  const app = await buildApp({
    deps: {
      env: testEnv(opts.env),
      logger: createLogger({ service: "api-test", level: "silent" }),
      pool: opts.pool,
      jobs,
      storage,
      auth: createDevProvider(DEV_SECRET),
      now: () => new Date(),
      ...opts.deps,
    },
    docs: false,
    isDraining: opts.isDraining,
    realtime: opts.realtime,
  });
  return { app, jobs, storage };
}

export const tokenFor = (subject: string) => mintDevToken(DEV_SECRET, subject, subject, "10m");
