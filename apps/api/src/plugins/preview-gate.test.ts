/**
 * Private-preview access gate (PREVIEW_ACCESS_GATE). No database: a pool that fails every query proves a refused
 * request never got past the gate, and a stub pool stands in for the user upsert of an authenticated request.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@metafarm/db";
import { buildTestApp, testEnv, tokenFor, unreachablePool } from "../test/helpers";
import { isOpenPath } from "./preview-gate";

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

const GATE = { PREVIEW_ACCESS_GATE: "true" };

/** Answers the user upsert the authentication step runs; fails anything else. */
function userPool(): Pool {
  const query = async (sql: string) => {
    if (/INSERT INTO users/.test(sql)) return { rows: [{ id: "00000000-0000-4000-8000-000000000001", oidc_issuer: "dev", oidc_subject: "dev-user", email: null, display_name: "dev-user" }], rowCount: 1 };
    throw new Error(`unexpected query: ${sql.slice(0, 40)}`);
  };
  return { query, connect: query, end: async () => undefined } as unknown as Pool;
}

describe("preview access gate: off (the default)", () => {
  it("is off unless configured, and changes nothing", async () => {
    expect(testEnv().PREVIEW_ACCESS_GATE).toBe(false);
    ({ app } = await buildTestApp({ pool: unreachablePool() }));
    // An unknown route answers 404 to anyone, as before.
    const r = await app.inject({ method: "GET", url: "/no-such-route" });
    expect(r.statusCode).toBe(404);
  });

  it("refuses to start with an unrecognised value (fails closed at boot)", () => {
    expect(() => testEnv({ PREVIEW_ACCESS_GATE: "yes" })).toThrow();
    expect(() => testEnv({ PREVIEW_ACCESS_GATE: "" })).toThrow();
  });
});

describe("preview access gate: on", () => {
  it("lets the platform health checks through without credentials", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: GATE }));
    const live = await app.inject({ method: "GET", url: "/healthz" });
    expect(live.statusCode).toBe(200);
    const liveQuery = await app.inject({ method: "GET", url: "/healthz?probe=1" });
    expect(liveQuery.statusCode).toBe(200);
    // Readiness passes the gate; it reports the (unreachable) database itself.
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).not.toBe(401);
  });

  it("refuses every other unauthenticated request with 401 before any route or query runs", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: GATE }));
    for (const url of ["/", "/no-such-route", "/docs", "/v1/me", "/v1/public/rwa/cnft/00000000-0000-4000-8000-000000000000", "/HEALTHZ", "/healthz/../v1/me", "/healthzx"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(401);
      expect(r.json().error, url).toBe("unauthorized");
    }
    const post = await app.inject({ method: "POST", url: "/v1/webhooks/anything", payload: {} });
    expect(post.statusCode).toBe(401);
  });

  it("refuses forged, malformed and non-bearer credentials", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: GATE }));
    for (const authorization of ["Bearer not.a.jwt", "Basic cHJldmlldzpzZWNyZXQ=", "Bearer ", "bearer x"]) {
      const r = await app.inject({ method: "GET", url: "/no-such-route", headers: { authorization } });
      expect(r.statusCode, authorization).toBe(401);
    }
  });

  it("answers CORS preflights for allowed origins (browsers send no credentials on them)", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: GATE }));
    const r = await app.inject({ method: "OPTIONS", url: "/v1/me", headers: { origin: "http://localhost:3000", "access-control-request-method": "GET" } });
    expect(r.statusCode).not.toBe(401);
    expect(r.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("lets a verified bearer token through to the routes", async () => {
    ({ app } = await buildTestApp({ pool: userPool(), env: GATE }));
    const r = await app.inject({ method: "GET", url: "/no-such-route", headers: { authorization: `Bearer ${await tokenFor("dev-user")}` } });
    // Past the gate: the router answers (404), not the gate (401).
    expect(r.statusCode).toBe(404);
  });

  it("matches open paths exactly", () => {
    expect(isOpenPath({ method: "GET", url: "/healthz" })).toBe(true);
    expect(isOpenPath({ method: "GET", url: "/readyz?x=1" })).toBe(true);
    expect(isOpenPath({ method: "OPTIONS", url: "/v1/anything" })).toBe(true);
    expect(isOpenPath({ method: "GET", url: "/healthz/" })).toBe(false);
    expect(isOpenPath({ method: "GET", url: "/docs" })).toBe(false);
    expect(isOpenPath({ method: "HEAD", url: "/v1/me" })).toBe(false);
  });

  it("passes device and integration ingestion that carries its own credential to the route, which verifies it", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: GATE }));
    // Past the gate: the routes answer with their own refusals (no database reached for these).
    const device = await app.inject({ method: "POST", url: "/v1/ingest/readings", headers: { authorization: "Sensor mfs_nonsense" }, payload: { readings: [] } });
    expect([device.statusCode, device.json().error]).toEqual([401, "invalid_sensor_token"]);
    const feed = await app.inject({ method: "POST", url: "/v1/integrations/44444444-4444-4444-8444-444444444444/events", headers: { "x-webhook-signature": "t=1,v1=00" }, payload: {} });
    expect([feed.statusCode, feed.json().error]).toEqual([404, "integrations_not_enabled"]);
    // Without that credential, or on any other path or method, the gate answers.
    for (const [method, url, headers] of [
      ["POST", "/v1/ingest/readings", {}],
      ["POST", "/v1/integrations/44444444-4444-4444-8444-444444444444/events", {}],
      ["GET", "/v1/integrations/44444444-4444-4444-8444-444444444444/events", { "x-webhook-signature": "t=1,v1=00" }],
      ["POST", "/v1/integrations/not-an-id/events", { "x-webhook-signature": "t=1,v1=00" }],
      ["POST", "/v1/webhooks/metafarm-relay", { "x-webhook-signature": "t=1,v1=00" }],
      ["GET", "/v1/me", { authorization: "Sensor mfs_nonsense" }],
    ] as const) {
      const r = await app.inject({ method, url, headers: { ...headers }, payload: method === "POST" ? {} : undefined });
      expect([r.statusCode, r.json().error], `${method} ${url}`).toEqual([401, "unauthorized"]);
    }
  });

  it("accepts the realtime channel's subprotocol token as the bearer token", async () => {
    ({ app } = await buildTestApp({ pool: userPool(), env: { ...GATE, REALTIME_EVENTS_ENABLED: "true" } }));
    const get = (protocols?: string) => app.inject({ method: "GET", url: "/v1/realtime", headers: protocols ? { "sec-websocket-protocol": protocols } : {} });
    // Past the gate and the route's own authentication: a plain GET (no upgrade) is then not found.
    expect((await get(`metafarm-realtime.1, bearer.${await tokenFor("dev-user")}`)).statusCode).toBe(404);
    // Only next to the realtime protocol, only on the realtime path, and only a valid token.
    expect((await get("metafarm-realtime.1, bearer.x.y.z")).statusCode).toBe(401);
    expect((await get(`bearer.${await tokenFor("dev-user")}`)).statusCode).toBe(401);
    expect((await get()).statusCode).toBe(401);
    const elsewhere = await app.inject({ method: "GET", url: "/no-such-route", headers: { "sec-websocket-protocol": `metafarm-realtime.1, bearer.${await tokenFor("dev-user")}` } });
    expect(elsewhere.statusCode).toBe(401);
  });
});
