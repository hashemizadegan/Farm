import type { FastifyInstance } from "fastify";
import { getFarm, periodReport } from "@metafarm/db";
import { reportQuerySchema, uuid } from "@metafarm/domain";
import { z } from "zod";
import { notFound, parse } from "../lib/http";

/** Drops a numeric's trailing zeros ("2.500" → "2.5"). */
const plain = (n: string) => (n.includes(".") ? n.replace(/0+$/, "").replace(/\.$/, "") : n);

/** A period summary for owners and managers: work done, inputs, harvests, spending, alerts. */
export async function reportRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/reports/summary", async (req) => {
    parse(z.object({ tenantId: uuid }), req.params);
    const q = parse(reportQuerySchema, req.query);
    return app.inTenant(req, "farm:read", async (tx) => {
      const farm = q.farmId ? await getFarm(tx, q.farmId) : undefined;
      if (q.farmId && !farm) throw notFound("farm");
      const r = await periodReport(tx, q);
      const money = (rows: { currency: string; amount: string; n: number }[]) => rows.map((x) => ({ currency: x.currency, amount: plain(x.amount), entries: x.n }));
      return {
        from: q.from,
        to: q.to,
        farm: farm ? { id: farm.id, name: farm.name } : null,
        tasks: {
          completed: r.tasksDone,
          due: r.tasksDue,
          dueStillOpen: r.tasksDueStillOpen,
          byKind: r.byKind.map((x) => ({ kind: x.kind, count: x.n })),
          byPerson: r.byPerson.map((x) => ({ userId: x.user_id, name: x.name, count: x.n })),
        },
        inputs: r.inputs.map((x) => ({ itemId: x.item_id, name: x.name, category: x.category, unit: x.unit, used: plain(x.used), applications: x.applications })),
        harvests: r.harvests.map((x) => ({ crop: x.crop, unit: x.unit, quantity: plain(x.quantity), batches: x.batches })),
        spending: { deliveries: money(r.deliveries), servicing: money(r.servicing) },
        alerts: {
          info: r.alerts.find((x) => x.severity === "info")?.n ?? 0,
          warning: r.alerts.find((x) => x.severity === "warning")?.n ?? 0,
          critical: r.alerts.find((x) => x.severity === "critical")?.n ?? 0,
        },
        observations: {
          userEntered: r.observations.find((x) => x.provenance === "user-entered")?.n ?? 0,
          sensorReported: r.observations.find((x) => x.provenance === "sensor-reported")?.n ?? 0,
          providerObservation: r.observations.find((x) => x.provenance === "provider-observation")?.n ?? 0,
        },
        farms: r.perFarm.map((x) => ({
          farmId: x.farm_id,
          name: x.name,
          tasksCompleted: x.tasks_done,
          applications: x.applications,
          harvestBatches: x.harvest_batches,
          alerts: x.alerts,
        })),
      };
    });
  });
}
