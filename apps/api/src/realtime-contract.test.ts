/**
 * Realtime preparation must not change the polling API: with REALTIME_EVENTS_ENABLED on or off the route table is
 * identical (no push endpoint exists), and the switch is refused for deployed environments.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, testEnv, unreachablePool } from "./test/helpers";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe("realtime events: contract preparation only", () => {
  it("is off by default and refused in staging/production", () => {
    expect(testEnv().REALTIME_EVENTS_ENABLED).toBe(false);
    for (const APP_ENV of ["staging", "production"]) {
      expect(() => testEnv({ APP_ENV, REALTIME_EVENTS_ENABLED: "true" })).toThrow(/REALTIME_EVENTS_ENABLED/);
    }
  });

  it("leaves the route table, and so every polling endpoint, exactly as it is", async () => {
    const off = (await buildTestApp({ pool: unreachablePool() })).app;
    const on = (await buildTestApp({ pool: unreachablePool(), env: { REALTIME_EVENTS_ENABLED: "true" } })).app;
    apps.push(off, on);
    await Promise.all([off.ready(), on.ready()]);
    expect(on.printRoutes({ commonPrefix: false })).toBe(off.printRoutes({ commonPrefix: false }));
    for (const path of ["/v1/events", "/v1/realtime", "/v1/ws"]) {
      expect((await on.inject({ method: "GET", url: path })).statusCode, path).toBe(404);
    }
  });
});
