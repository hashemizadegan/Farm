/** GET /metrics and request metrics: off by default, token-protected, route templates only. */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, unreachablePool } from "./test/helpers";

const TOKEN = "metrics-token-for-tests-0123456789abcdef";
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

const scrape = (authorization?: string) => app.inject({ method: "GET", url: "/metrics", headers: authorization ? { authorization } : {} });

describe("metrics endpoint", () => {
  it("is off without METRICS_TOKEN: 404, like an unknown route", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool() }));
    const r = await scrape(`Bearer ${TOKEN}`);
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe("not_found");
  });

  it("needs the token when on", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: { METRICS_TOKEN: TOKEN } }));
    expect((await scrape()).statusCode).toBe(401);
    expect((await scrape(`Bearer ${TOKEN}0`)).statusCode).toBe(401);
    const r = await scrape(`Bearer ${TOKEN}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  it("counts responses by route template and status, never by raw URL, and not its own scrapes", async () => {
    ({ app } = await buildTestApp({ pool: unreachablePool(), env: { METRICS_TOKEN: TOKEN } }));
    const tenantId = randomUUID();
    await app.inject({ method: "GET", url: "/v1/me" });
    await app.inject({ method: "GET", url: "/v1/me" });
    await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/farms` });
    await app.inject({ method: "GET", url: `/no/such/${tenantId}` });
    await scrape(`Bearer ${TOKEN}`);
    const text = (await scrape(`Bearer ${TOKEN}`)).body;

    expect(text).toContain('metafarm_http_requests_total{method="GET",route="/v1/me",status="401"} 2\n');
    expect(text).toContain('metafarm_http_requests_total{method="GET",route="/v1/tenants/:tenantId/farms",status="401"} 1\n');
    expect(text).toContain('metafarm_http_requests_total{method="GET",route="unmatched",status="404"} 1\n');
    expect(text).toContain('metafarm_http_request_duration_seconds_count{method="GET",route="/v1/me"} 2\n');
    expect(text).not.toContain(tenantId);
    expect(text).not.toContain('route="/metrics"');
  });
});
