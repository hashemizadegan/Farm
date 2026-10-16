/**
 * HTTP-layer tests that need no database: security headers, CORS, auth
 * rejection, body limits, rate limiting, webhook signatures, error shape.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { signWebhook } from "@metafarm/domain/server";
import { buildTestApp, unreachablePool } from "./test/helpers";

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

describe("security baseline", () => {
  it("serves liveness without auth and sets security headers", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool() }));
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: "ok" });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(r.headers["x-request-id"]).toBeDefined();
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("reports draining during shutdown so the platform stops routing traffic", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), isDraining: () => true }));
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ status: "draining" });
  });

  it("rejects requests without a bearer token before touching the database", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool() }));
    const r = await app.inject({ method: "GET", url: "/v1/me" });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe("unauthorized");
  });

  it("rejects forged tokens", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool() }));
    const r = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer not.a.jwt" } });
    expect(r.statusCode).toBe(401);
  });

  it("allows configured CORS origins only", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool() }));
    const ok = await app.inject({
      method: "OPTIONS",
      url: "/v1/me",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "GET" },
    });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const bad = await app.inject({
      method: "OPTIONS",
      url: "/v1/me",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("enforces the body size limit", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: { BODY_LIMIT_BYTES: "2048" } }));
    const r = await app.inject({
      method: "POST",
      url: "/v1/tenants/00000000-0000-0000-0000-000000000000/farms",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(5_000) }),
    });
    expect(r.statusCode).toBe(413);
  });

  it("rejects prototype-pollution payloads", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool() }));
    const r = await app.inject({
      method: "POST",
      url: "/v1/tenants/00000000-0000-0000-0000-000000000000/farms",
      headers: { "content-type": "application/json" },
      payload: '{"__proto__": {"admin": true}, "name": "x"}',
    });
    expect(r.statusCode).toBe(400);
  });

  it("rate-limits by client", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: { RATE_LIMIT_MAX: "3" } }));
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: "GET", url: "/v1/me" })).statusCode);
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes[4]).toBe(429);
  });

  it("returns JSON 404s without stack traces", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool() }));
    const r = await app.inject({ method: "GET", url: "/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual(expect.objectContaining({ error: "not_found" }));
    expect(r.body).not.toContain("at ");
  });
});

describe("webhooks", () => {
  const body = JSON.stringify({ id: "evt_1", type: "sensor.reading", data: {} });

  it("rejects missing and forged signatures before any processing", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool() }));
    const missing = await app.inject({ method: "POST", url: "/v1/webhooks/acme", headers: { "content-type": "application/json" }, payload: body });
    expect(missing.statusCode).toBe(401);
    const forged = await app.inject({
      method: "POST",
      url: "/v1/webhooks/acme",
      headers: { "content-type": "application/json", "x-webhook-signature": signWebhook("wrong", body, Math.floor(Date.now() / 1000)) },
      payload: body,
    });
    expect(forged.statusCode).toBe(401);
  });

  it("rejects a valid signature over a modified body", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool() }));
    const sig = signWebhook("whsec_test", body, Math.floor(Date.now() / 1000));
    const r = await app.inject({
      method: "POST",
      url: "/v1/webhooks/acme",
      headers: { "content-type": "application/json", "x-webhook-signature": sig },
      payload: body.replace("evt_1", "evt_2"),
    });
    expect(r.statusCode).toBe(401);
  });
});
