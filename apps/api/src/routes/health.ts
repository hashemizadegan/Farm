import type { FastifyInstance } from "fastify";
import { pingDatabase } from "@metafarm/db";
import { runChecks } from "@metafarm/observability";

export async function healthRoutes(app: FastifyInstance, opts: { isDraining: () => boolean }) {
  app.get("/healthz", { logLevel: "silent" }, async (_req, reply) => {
    const draining = opts.isDraining();
    return reply.status(draining ? 503 : 200).send({ status: draining ? "draining" : "ok" });
  });

  app.get("/readyz", { logLevel: "silent" }, async (_req, reply) => {
    const { pool, jobs, storage } = app.deps;
    const report = await runChecks([
      { name: "database", check: () => pingDatabase(pool) },
      { name: "queue", check: () => jobs.ping() },
      { name: "storage", check: () => storage.ping() },
    ]);
    const ok = report.status === "ok" && !opts.isDraining();
    return reply.status(ok ? 200 : 503).send(report);
  });
}
