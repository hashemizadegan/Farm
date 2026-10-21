import { createServer, type Server } from "node:http";
import { PROMETHEUS_CONTENT_TYPE } from "./metrics";
import { metricsAuthorized } from "./standard-metrics";

export type HealthCheck = { name: string; check: () => Promise<boolean> };

export interface HealthReport {
  status: "ok" | "degraded";
  checks: Record<string, "ok" | "fail">;
}

export async function runChecks(checks: HealthCheck[], timeoutMs = 2_000): Promise<HealthReport> {
  const results: Record<string, "ok" | "fail"> = {};
  await Promise.all(
    checks.map(async (c) => {
      try {
        const ok = await Promise.race([
          c.check(),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref()),
        ]);
        results[c.name] = ok ? "ok" : "fail";
      } catch {
        results[c.name] = "fail";
      }
    }),
  );
  const status = Object.values(results).every((r) => r === "ok") ? "ok" : "degraded";
  return { status, checks: results };
}

/**
 * Minimal health server for non-HTTP services (worker, scheduler).
 * - GET /healthz : liveness, always 200 while the process runs and is not draining
 * - GET /readyz  : readiness, 200 only when every dependency check passes
 * - GET /metrics : Prometheus text, only with `metrics.token` set and `Authorization: Bearer <token>`
 *   (401 otherwise); without a token it is 404 like any other path
 */
export function startHealthServer(opts: {
  port: number;
  /** Use "::" on platforms whose private network is IPv6 (e.g. Railway). */
  host?: string;
  checks: HealthCheck[];
  isDraining: () => boolean;
  metrics?: { token: string | undefined; render: () => Promise<string> };
}): Server {
  const server = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      const draining = opts.isDraining();
      res.writeHead(draining ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: draining ? "draining" : "ok" }));
      return;
    }
    if (req.url === "/readyz") {
      const report = await runChecks(opts.checks);
      const ok = report.status === "ok" && !opts.isDraining();
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(report));
      return;
    }
    if (req.url === "/metrics" && req.method === "GET" && opts.metrics?.token) {
      if (!metricsAuthorized(req.headers.authorization, opts.metrics.token)) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      try {
        const body = await opts.metrics.render();
        res.writeHead(200, { "content-type": PROMETHEUS_CONTENT_TYPE }).end(body);
      } catch {
        res.writeHead(500).end();
      }
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(opts.port, opts.host ?? process.env.HOST ?? "0.0.0.0");
  return server;
}
