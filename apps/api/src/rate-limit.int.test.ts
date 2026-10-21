/**
 * Shared rate limits (RATE_LIMIT_STORE=redis): needs the Redis service from the integration job.
 * Two API instances stand in for two replicas.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { createRateLimitRedis } from "./lib/rate-limit-redis";
import { buildTestApp, unreachablePool } from "./test/helpers";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const quiet = { warn: () => undefined };

const apps: FastifyInstance[] = [];
const clients: Redis[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const c of clients.splice(0)) c.disconnect();
});

async function replica(env: Record<string, string>, redis?: Redis) {
  const { app } = await buildTestApp({ pool: unreachablePool(), env, deps: redis ? { rateLimitRedis: redis } : {} });
  apps.push(app);
  return app;
}

function client(url = REDIS_URL) {
  const c = createRateLimitRedis(url, quiet);
  clients.push(c);
  return c;
}

const hit = async (app: FastifyInstance) => (await app.inject({ method: "GET", url: "/v1/me" })).statusCode;

describe("rate limits shared through Redis", () => {
  it("counts requests to every replica against one budget", async () => {
    const env = { RATE_LIMIT_STORE: "redis", RATE_LIMIT_MAX: "4", QUEUE_PREFIX: `rl-${randomUUID()}` };
    const a = await replica(env, client());
    const b = await replica(env, client());
    expect([await hit(a), await hit(b), await hit(a), await hit(b)]).toEqual([401, 401, 401, 401]);
    expect(await hit(a)).toBe(429);
    expect(await hit(b)).toBe(429);
  });

  it("keeps per-process budgets with the default memory store", async () => {
    const env = { RATE_LIMIT_MAX: "2", QUEUE_PREFIX: `rl-${randomUUID()}` };
    const a = await replica(env);
    const b = await replica(env);
    expect([await hit(a), await hit(a), await hit(a)]).toEqual([401, 401, 429]);
    expect(await hit(b)).toBe(401);
  });

  it("separates environments that share a Redis by QUEUE_PREFIX", async () => {
    const a = await replica({ RATE_LIMIT_STORE: "redis", RATE_LIMIT_MAX: "1", QUEUE_PREFIX: `rl-${randomUUID()}` }, client());
    const b = await replica({ RATE_LIMIT_STORE: "redis", RATE_LIMIT_MAX: "1", QUEUE_PREFIX: `rl-${randomUUID()}` }, client());
    expect([await hit(a), await hit(a)]).toEqual([401, 429]);
    expect(await hit(b)).toBe(401);
  });

  it("serves requests without limits when Redis is unreachable (fail open)", async () => {
    const down = client("redis://127.0.0.1:1");
    const a = await replica({ RATE_LIMIT_STORE: "redis", RATE_LIMIT_MAX: "1", QUEUE_PREFIX: `rl-${randomUUID()}` }, down);
    expect([await hit(a), await hit(a), await hit(a)]).toEqual([401, 401, 401]);
  });

  it("refuses to start with RATE_LIMIT_STORE=redis and no Redis client", async () => {
    let error: unknown;
    try {
      await replica({ RATE_LIMIT_STORE: "redis" });
    } catch (e) {
      error = e;
    }
    expect(String(error)).toContain("RATE_LIMIT_STORE=redis");
  });
});
