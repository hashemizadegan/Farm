/**
 * The realtime channel is opt-in: with REALTIME_EVENTS_ENABLED off (the default) no realtime route exists and the
 * polling API is exactly as before; switched on, the only addition is GET /v1/realtime, which refuses an
 * unauthenticated handshake before any database work. The switch is refused for deployed environments.
 */
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, testEnv, unreachablePool } from "./test/helpers";
import { upgradeStatus } from "./test/realtime-client";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const routeLines = (app: FastifyInstance) =>
  app
    .printRoutes({ commonPrefix: false })
    .split("\n")
    .map((l) => l.replace(/^[\s│├└─]+/, "").trim())
    .filter(Boolean)
    .sort();

describe("realtime channel: opt-in", () => {
  it("is off by default and refused in staging/production", () => {
    expect(testEnv().REALTIME_EVENTS_ENABLED).toBe(false);
    for (const APP_ENV of ["staging", "production"]) {
      expect(() => testEnv({ APP_ENV, REALTIME_EVENTS_ENABLED: "true" })).toThrow(/REALTIME_EVENTS_ENABLED/);
    }
  });

  it("off: no realtime route; on: only GET /v1/realtime is added, every polling endpoint is unchanged", async () => {
    const off = (await buildTestApp({ pool: unreachablePool() })).app;
    const on = (await buildTestApp({ pool: unreachablePool(), env: { REALTIME_EVENTS_ENABLED: "true" } })).app;
    apps.push(off, on);
    await Promise.all([off.ready(), on.ready()]);
    expect(off.hasRoute({ method: "GET", url: "/v1/realtime" })).toBe(false);
    expect(on.hasRoute({ method: "GET", url: "/v1/realtime" })).toBe(true);
    // Route-table lines of `on` that `off` lacks (multiset difference), and the reverse.
    const offLines = routeLines(off);
    const added: string[] = [];
    for (const l of routeLines(on)) {
      const i = offLines.indexOf(l);
      if (i >= 0) offLines.splice(i, 1);
      else added.push(l);
    }
    expect(offLines).toEqual([]);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((l) => /realtime/.test(l))).toBe(true);
    for (const path of ["/v1/realtime", "/v1/events", "/v1/ws"]) {
      expect((await off.inject({ method: "GET", url: path })).statusCode, path).toBe(404);
    }
    // Not an upgrade: authentication first (401), and a plain GET never serves anything.
    expect((await on.inject({ method: "GET", url: "/v1/realtime" })).statusCode).toBe(401);
  });

  it("refuses an unauthenticated or badly authenticated handshake with 401, before touching the database", async () => {
    const on = (await buildTestApp({ pool: unreachablePool(), env: { REALTIME_EVENTS_ENABLED: "true" } })).app;
    apps.push(on);
    await on.listen({ port: 0, host: "127.0.0.1" });
    const port = (on.server.address() as AddressInfo).port;
    expect(await upgradeStatus(port, {})).toBe(401);
    expect(await upgradeStatus(port, { authorization: "Bearer x.y.z" })).toBe(401);
    expect(await upgradeStatus(port, { "sec-websocket-protocol": "metafarm-realtime.1, bearer.x.y.z" })).toBe(401);
    // The bearer subprotocol is only honoured next to the realtime protocol.
    expect(await upgradeStatus(port, { "sec-websocket-protocol": "bearer.x.y.z" })).toBe(401);
  });
});
