import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  appendRealtimeEvent,
  getFarm,
  getSensor,
  getSensorForIngest,
  insertAlertRule,
  insertRawObservation,
  insertSensor,
  listAlertRules,
  listSensors,
  setAlertRuleEnabled,
  setSensorCredential,
  touchSensor,
  updateSensor,
  withSystem,
  withTenant,
  writeSystemAudit,
  type AlertRuleRow,
  type SensorRow,
} from "@metafarm/db";
import {
  QUEUES,
  alertRuleSchema,
  createSensorSchema,
  ingestSchema,
  sensorIdFromToken,
  sensorState,
  sensorTokenPrefix,
  updateSensorSchema,
  uuid,
} from "@metafarm/domain";
import { z } from "zod";
import { HttpError, hashIp, notFound, parse } from "../lib/http";

const farmParams = z.object({ tenantId: uuid, farmId: uuid });
const sensorParams = farmParams.extend({ sensorId: uuid });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = (sensorId: string) => `${sensorTokenPrefix(sensorId)}${randomBytes(32).toString("base64url")}`;

export async function sensorRoutes(app: FastifyInstance) {
  const toSensor = (s: SensorRow) => ({
    id: s.id,
    farmId: s.farm_id,
    name: s.name,
    kind: s.kind,
    parcelLabel: s.parcel_label,
    location: s.lon === null || s.lat === null ? null : { lon: s.lon, lat: s.lat },
    status: s.status,
    state: sensorState({ status: s.status, lastSeenAt: s.last_seen_at && new Date(s.last_seen_at).toISOString(), silentAfterMinutes: s.silent_after_minutes }, app.deps.now()),
    lastSeenAt: s.last_seen_at ? new Date(s.last_seen_at).toISOString() : null,
    silentAfterMinutes: s.silent_after_minutes,
    credentialRotatedAt: s.credential_rotated_at ? new Date(s.credential_rotated_at).toISOString() : null,
    latest: s.latest.map((l) => ({ metric: l.metric, value: l.value, unit: l.unit, observedAt: new Date(l.observed_at).toISOString() })),
    createdAt: new Date(s.created_at).toISOString(),
  });

  const toRule = (r: AlertRuleRow) => ({
    id: r.id,
    metric: r.metric,
    comparator: r.comparator,
    threshold: r.threshold,
    consecutive: r.consecutive,
    severity: r.severity,
    windowMinutes: Math.round(r.window_seconds / 60),
    enabled: r.enabled,
    createdAt: new Date(r.created_at).toISOString(),
  });

  app.get("/v1/tenants/:tenantId/farms/:farmId/sensors", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    return app.inTenant(req, "farm:read", async (tx) => {
      if (!(await getFarm(tx, farmId))) throw notFound("farm");
      return { items: (await listSensors(tx, farmId)).map(toSensor) };
    });
  });

  app.post("/v1/tenants/:tenantId/farms/:farmId/sensors", async (req, reply) => {
    const { farmId } = parse(farmParams, req.params);
    const body = parse(createSensorSchema, req.body);
    const id = randomUUID();
    const token = newToken(id);
    const s = await app.inTenant(req, "sensor:manage", async (tx) => {
      if (!(await getFarm(tx, farmId))) throw notFound("farm");
      await insertSensor(tx, farmId, id, body, sha256(token), req.user!.id);
      await app.audit(req, tx, { action: "sensor.created", targetType: "sensor", targetId: id, metadata: { farmId, kind: body.kind } });
      return (await getSensor(tx, farmId, id))!;
    });
    // The token is shown once; only its hash is stored.
    return reply.status(201).header("cache-control", "no-store").send({ sensor: toSensor(s), token });
  });

  app.patch("/v1/tenants/:tenantId/farms/:farmId/sensors/:sensorId", async (req) => {
    const { farmId, sensorId } = parse(sensorParams, req.params);
    const body = parse(updateSensorSchema, req.body);
    return app.inTenant(req, "sensor:manage", async (tx) => {
      if (!(await getSensor(tx, farmId, sensorId))) throw notFound("sensor");
      await updateSensor(tx, sensorId, body);
      await app.audit(req, tx, { action: "sensor.updated", targetType: "sensor", targetId: sensorId, metadata: { fields: Object.keys(body) } });
      return toSensor((await getSensor(tx, farmId, sensorId))!);
    });
  });

  app.post("/v1/tenants/:tenantId/farms/:farmId/sensors/:sensorId/rotate", async (req, reply) => {
    const { farmId, sensorId } = parse(sensorParams, req.params);
    const token = newToken(sensorId);
    const s = await app.inTenant(req, "sensor:manage", async (tx) => {
      if (!(await getSensor(tx, farmId, sensorId))) throw notFound("sensor");
      await setSensorCredential(tx, sensorId, sha256(token));
      await app.audit(req, tx, { action: "sensor.credential_rotated", targetType: "sensor", targetId: sensorId });
      return (await getSensor(tx, farmId, sensorId))!;
    });
    return reply.header("cache-control", "no-store").send({ sensor: toSensor(s), token });
  });

  // ── Device ingestion: authenticated by the sensor's own token, not a user. ──
  app.post("/v1/ingest/readings", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Sensor ") ? header.slice(7).trim() : "";
    const sensorId = sensorIdFromToken(token);
    const deny = async (reason: string) => {
      await writeSystemAudit(app.deps.pool, null, {
        actorType: "device",
        action: "sensor.ingest_rejected",
        outcome: "denied",
        metadata: { reason },
        requestId: req.id,
        ipHash: hashIp(req.ip),
      }).catch(() => undefined);
      return new HttpError(401, "invalid_sensor_token", "sensor token missing, unknown or revoked");
    };
    if (!sensorId) throw await deny("malformed");
    const sensor = await withSystem(app.deps.pool, (tx) => getSensorForIngest(tx, sensorId));
    const presented = Buffer.from(sha256(token), "hex");
    const stored = sensor?.credential_hash ? Buffer.from(sensor.credential_hash, "hex") : Buffer.alloc(32);
    // Constant-time comparison; an unknown sensor still costs the same work.
    if (!sensor || !sensor.credential_hash || !timingSafeEqual(presented, stored)) throw await deny("unknown");
    if (sensor.status !== "active") throw await deny("disabled");

    const body = parse(ingestSchema, req.body);
    const ids = await withTenant(app.deps.pool, sensor.tenant_id, async (tx) => {
      const out: string[] = [];
      for (const r of body.readings) {
        out.push((await insertRawObservation(tx, { farmId: sensor.farm_id, sensorId: sensor.id, payload: r, provenance: "sensor-reported" })).id);
      }
      await touchSensor(tx, sensor.id);
      // Realtime outbox (only when the channel is on): a notification that readings arrived, in the same transaction.
      if (app.deps.env.REALTIME_EVENTS_ENABLED) {
        await appendRealtimeEvent(tx, {
          scheme: "metafarm-event/1",
          type: "sensor.reading.received",
          schemaVersion: 1,
          id: randomUUID(),
          scope: { tenantId: sensor.tenant_id, farmId: sensor.farm_id },
          occurredAt: app.deps.now().toISOString(),
          correlationId: req.id.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128) || null,
          payload: { sensorId: sensor.id, rawObservationIds: out, metrics: [...new Set(body.readings.map((r) => r.metric))], source: "sensor" },
        });
      }
      return out;
    });
    for (const id of ids) await app.deps.jobs.enqueue(QUEUES.observations, { tenantId: sensor.tenant_id, farmId: sensor.farm_id, rawObservationId: id });
    return reply.status(202).send({ accepted: ids.length });
  });

  // ── Alert rules ──
  app.get("/v1/tenants/:tenantId/farms/:farmId/alert-rules", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    return app.inTenant(req, "alert:read", async (tx) => ({ items: (await listAlertRules(tx, farmId)).map(toRule) }));
  });

  app.post("/v1/tenants/:tenantId/farms/:farmId/alert-rules", async (req, reply) => {
    const { farmId } = parse(farmParams, req.params);
    const body = parse(alertRuleSchema, req.body);
    const rule = await app.inTenant(req, "sensor:manage", async (tx) => {
      if (!(await getFarm(tx, farmId))) throw notFound("farm");
      const id = await insertAlertRule(tx, farmId, body, req.user!.id);
      await app.audit(req, tx, { action: "alert_rule.created", targetType: "alert_rule", targetId: id, metadata: { metric: body.metric } });
      return (await listAlertRules(tx, farmId)).find((r) => r.id === id)!;
    });
    return reply.status(201).send(toRule(rule));
  });

  app.patch("/v1/tenants/:tenantId/farms/:farmId/alert-rules/:ruleId", async (req) => {
    const { farmId, ruleId } = parse(farmParams.extend({ ruleId: uuid }), req.params);
    const { enabled } = parse(z.object({ enabled: z.boolean() }).strict(), req.body);
    return app.inTenant(req, "sensor:manage", async (tx) => {
      if (!(await setAlertRuleEnabled(tx, farmId, ruleId, enabled))) throw notFound("alert rule");
      await app.audit(req, tx, { action: enabled ? "alert_rule.enabled" : "alert_rule.disabled", targetType: "alert_rule", targetId: ruleId });
      return toRule((await listAlertRules(tx, farmId)).find((r) => r.id === ruleId)!);
    });
  });
}
