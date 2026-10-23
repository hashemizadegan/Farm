import type { FastifyInstance } from "fastify";
import { acknowledgeAlert, findObservationByRequest, getFarm, getObservationDetail, insertRawObservation, listAlerts, listObservations } from "@metafarm/db";
import { QUEUES, ackAlertSchema, createObservationSchema, uuid } from "@metafarm/domain";
import { z } from "zod";
import { idempotencyKey, keyReused, notFound, parse } from "../lib/http";
import { toAlert, toObservation } from "../lib/mappers";

const farmParams = z.object({ tenantId: uuid, farmId: uuid });

export async function observationRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/farms/:farmId/observations", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    const q = parse(
      z.object({
        metric: z.string().max(40).optional(),
        since: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    return app.inTenant(req, "observation:read", async (tx) => ({
      items: (await listObservations(tx, farmId, q)).map(toObservation),
    }));
  });

  /**
   * One observation and where it came from: when the raw record was received (and by whom, for user entries), the
   * sensor, and the registered integration and provider event id for provider data. Ids and names only: no secrets.
   */
  app.get("/v1/tenants/:tenantId/farms/:farmId/observations/:observationId", async (req) => {
    const { farmId, observationId } = parse(farmParams.extend({ observationId: uuid }), req.params);
    return app.inTenant(req, "observation:read", async (tx) => {
      const o = await getObservationDetail(tx, farmId, observationId);
      if (!o) throw notFound("observation");
      const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());
      return {
        ...toObservation(o),
        originalValue: o.original_value,
        originalUnit: o.original_unit,
        recordedAt: iso(o.created_at),
        receivedAt: iso(o.received_at),
        source: {
          kind: o.integration_id ? "integration" : o.sensor_id ? "sensor" : o.provenance_label === "user-entered" ? "user" : "unknown",
          sensor: o.sensor_id ? { id: o.sensor_id, name: o.sensor_name } : null,
          integration: o.integration_id
            ? { id: o.integration_id, name: o.integration_name!, provider: o.integration_provider!, status: o.integration_status!, providerEventId: o.provider_event_id! }
            : null,
          enteredBy: o.provenance_label === "user-entered" ? o.received_by_name : null,
        },
      };
    });
  });

  /**
   * Observations entered through the API are `user-entered`. Sensor and
   * provider data arrive through signed webhooks and carry their own labels.
   */
  app.post("/v1/tenants/:tenantId/farms/:farmId/observations", { config: { idempotency: "handler" } }, async (req, reply) => {
    const { tenantId, farmId } = parse(farmParams, req.params);
    const body = parse(createObservationSchema, req.body);
    const key = idempotencyKey(req);
    const raw = await app.inTenant(req, "observation:write", async (tx) => {
      if (!(await getFarm(tx, farmId))) throw notFound("farm");
      if (key) {
        const seen = await findObservationByRequest(tx, key);
        if (seen && (seen.farm_id !== farmId || seen.received_by !== req.user!.id)) throw keyReused();
        if (seen) return { id: seen.id, replay: true };
      }
      const r = await insertRawObservation(tx, {
        farmId,
        sensorId: body.sensorId,
        payload: body,
        provenance: "user-entered",
        userId: req.user!.id,
        clientRequestId: key,
      });
      await app.audit(req, tx, { action: "observation.submitted", targetType: "raw_observation", targetId: r.id, metadata: { farmId, metric: body.metric } });
      return { id: r.id, replay: false };
    });
    if (!raw.replay) await app.deps.jobs.enqueue(QUEUES.observations, { tenantId, farmId, rawObservationId: raw.id });
    return reply.status(202).send({ rawObservationId: raw.id, provenance: "user-entered" });
  });

  app.get("/v1/tenants/:tenantId/farms/:farmId/alerts", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    const { status } = parse(z.object({ status: z.enum(["open", "acknowledged", "resolved"]).optional() }), req.query);
    return app.inTenant(req, "alert:read", async (tx) => ({ items: (await listAlerts(tx, farmId, status)).map(toAlert) }));
  });

  app.post("/v1/tenants/:tenantId/farms/:farmId/alerts/:alertId/ack", async (req) => {
    const { farmId, alertId } = parse(farmParams.extend({ alertId: uuid }), req.params);
    const body = parse(ackAlertSchema, req.body ?? {});
    return app.inTenant(req, "alert:ack", async (tx) => {
      const a = await acknowledgeAlert(tx, farmId, alertId, req.user!.id, body.note);
      if (!a) throw notFound("open alert");
      await app.audit(req, tx, { action: "alert.acknowledged", targetType: "alert", targetId: alertId });
      return toAlert(a);
    });
  });
}
