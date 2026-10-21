import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { MetricsRegistry, PROMETHEUS_CONTENT_TYPE, createHttpMetrics, metricsAuthorized } from "@metafarm/observability";
import { HttpError } from "../lib/http";

/**
 * Request metrics and GET /metrics (Prometheus text).
 *
 * Every response is counted by method, route template and status, and timed. Routes are templates
 * (`/v1/tenants/:tenantId/farms`), never raw URLs, so ids never become label values; requests that
 * match no route are counted as `unmatched`.
 *
 * The endpoint is off unless METRICS_TOKEN is set: without it, GET /metrics answers 404 like any
 * unknown route. With it, the request needs `Authorization: Bearer <METRICS_TOKEN>` (401 otherwise).
 * It is not tenant-scoped and reveals no tenant data: only counts and timings per route template.
 */
export const metricsPlugin = fp(async (app: FastifyInstance, opts: { token?: string; registry?: MetricsRegistry }) => {
  const registry = opts.registry ?? new MetricsRegistry();
  const http = createHttpMetrics(registry);

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unmatched";
    if (route === "/metrics") return; // scrapes are not traffic
    http.requests.inc({ method: req.method, route, status: reply.statusCode });
    http.duration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
  });

  app.get("/metrics", { logLevel: "silent" }, async (req, reply) => {
    if (!opts.token) throw new HttpError(404, "not_found", "route not found");
    if (!metricsAuthorized(req.headers.authorization, opts.token)) throw new HttpError(401, "unauthorized", "the metrics token is required");
    reply.header("content-type", PROMETHEUS_CONTENT_TYPE);
    return registry.render();
  });
});
