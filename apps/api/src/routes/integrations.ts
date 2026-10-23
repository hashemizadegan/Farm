/**
 * Registered integrations (migration 0031): administration and signed ingestion.
 *
 * Administration (`integration:manage`): register, list, rotate and revoke. The signing secret is derived from
 * INTEGRATION_SECRET_KEY and shown once (registration and rotation); only its SHA-256 is stored.
 *
 * Ingestion, POST /v1/integrations/{integrationId}/events, in this order, nothing stored before step 5:
 *  1. the integration is resolved by the id in the path (its workspace is the only workspace this request can touch);
 *  2. the signature (`x-webhook-signature: t=<unix>,v1=<hex>` over `<t>.<raw body>`, the platform's webhook scheme)
 *     is verified with that integration's current secret, within WEBHOOK_TOLERANCE_SECONDS;
 *  3. a revoked integration is refused;
 *  4. the payload (`metafarm-integration-event/1`) is validated; any workspace identity in it is refused, and its
 *     sensor or farm must exist in the integration's workspace;
 *  5. in one transaction of that workspace: raw observations (`provider-observation`) for the existing observation
 *     pipeline, the idempotency row (integration + provider event id) and, when the realtime channel is on, an outbox
 *     event; then the observation-normalization jobs are queued. A replay stores nothing and answers `duplicate`.
 * Every outcome writes an audit row: accepted, replayed, rejected (with the reason) or revoked.
 */
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  appendRealtimeEvent,
  getFarm,
  getIntegrationForIngest,
  insertIntegration,
  insertRawObservation,
  integrationEventSeen,
  listIntegrations,
  recordIntegrationEvent,
  revokeIntegration,
  rotateIntegrationSecret,
  withSystem,
  withTenant,
  writeSystemAudit,
  type IntegrationRow,
  type TenantTx,
} from "@metafarm/db";
import { IntegrationEventRefusal, QUEUES, parseIntegrationEvent, registerIntegrationSchema, uuid, type IntegrationEvent } from "@metafarm/domain";
import { deriveIntegrationSecret, integrationSecretSha256, verifyWebhookSignature } from "@metafarm/domain/server";
import { z } from "zod";
import { HttpError, hashIp, notFound, parse } from "../lib/http";

const tenantParams = z.object({ tenantId: uuid });
const integrationParams = tenantParams.extend({ integrationId: uuid });

export const SIGNING = {
  header: "x-webhook-signature",
  format: "t=<unix seconds>,v1=<hex HMAC-SHA256 of `<t>.<raw body>` with the integration secret>",
} as const;

export const toIntegration = (r: IntegrationRow) => ({
  id: r.id,
  kind: r.kind,
  provider: r.provider,
  name: r.name,
  status: r.status,
  allowedEventTypes: r.allowed_event_types,
  secretVersion: r.secret_version,
  createdAt: new Date(r.created_at).toISOString(),
  rotatedAt: r.rotated_at ? new Date(r.rotated_at).toISOString() : null,
  lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
  revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
});

class Duplicate extends Error {}

/** Writes one integration event's raw observations; returns them with the sensor, when there is one. */
async function normalizeIntoPipeline(tx: TenantTx, e: IntegrationEvent): Promise<{ farmId: string; sensorId: string | null; ids: string[]; metrics: string[] }> {
  if (e.type === "sensor.readings") {
    const s = (await tx.query<{ farm_id: string; status: string }>(`SELECT farm_id, status FROM sensors WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, e.sensorId])).rows[0];
    if (!s) throw new HttpError(422, "integration_event_unknown_sensor", "no such sensor in this integration's workspace");
    if (s.status !== "active") throw new HttpError(422, "integration_event_sensor_disabled", "the sensor is disabled");
    const ids: string[] = [];
    for (const r of e.readings) ids.push((await insertRawObservation(tx, { farmId: s.farm_id, sensorId: e.sensorId, payload: r, provenance: "provider-observation" })).id);
    await tx.query(`UPDATE sensors SET last_seen_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, e.sensorId]);
    return { farmId: s.farm_id, sensorId: e.sensorId, ids, metrics: [...new Set(e.readings.map((r) => r.metric))] };
  }
  if (!(await getFarm(tx, e.farmId))) throw new HttpError(422, "integration_event_unknown_farm", "no such farm in this integration's workspace");
  const sensorIds = [...new Set(e.observations.map((o) => o.sensorId).filter((x): x is string => Boolean(x)))];
  if (sensorIds.length) {
    const found = await tx.query(`SELECT id FROM sensors WHERE tenant_id = $1 AND farm_id = $2 AND id = ANY($3::uuid[])`, [tx.tenantId, e.farmId, sensorIds]);
    if (found.rowCount !== sensorIds.length) throw new HttpError(422, "integration_event_unknown_sensor", "a sensor is not on this farm");
  }
  const ids: string[] = [];
  for (const o of e.observations) ids.push((await insertRawObservation(tx, { farmId: e.farmId, sensorId: o.sensorId, payload: o, provenance: "provider-observation" })).id);
  return { farmId: e.farmId, sensorId: null, ids, metrics: [...new Set(e.observations.map((o) => o.metric))] };
}

export async function integrationRoutes(app: FastifyInstance) {
  const { env } = app.deps;
  const serverKey = (): string => {
    if (!env.INTEGRATION_SECRET_KEY) throw new HttpError(404, "integrations_not_enabled", "integrations are not enabled on this deployment");
    return env.INTEGRATION_SECRET_KEY;
  };
  const secretFor = (id: string, version: number) => deriveIntegrationSecret(serverKey(), id, version);

  app.get("/v1/tenants/:tenantId/integrations", async (req) => {
    parse(tenantParams, req.params);
    serverKey();
    return app.inTenant(req, "integration:manage", async (tx) => ({ items: (await listIntegrations(tx)).map(toIntegration) }));
  });

  app.post("/v1/tenants/:tenantId/integrations", async (req, reply) => {
    parse(tenantParams, req.params);
    serverKey();
    const body = parse(registerIntegrationSchema, req.body);
    const id = randomUUID();
    const secret = secretFor(id, 1);
    const row = await app.inTenant(req, "integration:manage", async (tx) => {
      const r = await insertIntegration(tx, { id, ...body, secretSha256: integrationSecretSha256(secret), createdBy: req.user!.id });
      await app.audit(req, tx, { action: "integration.registered", targetType: "integration", targetId: id, metadata: { kind: body.kind, provider: body.provider, allowedEventTypes: body.allowedEventTypes } });
      return r;
    });
    // The secret is shown once; only its hash is stored.
    return reply
      .status(201)
      .header("cache-control", "no-store")
      .send({ integration: toIntegration(row), secret, signing: { ...SIGNING, toleranceSeconds: env.WEBHOOK_TOLERANCE_SECONDS, url: `/v1/integrations/${id}/events` } });
  });

  app.post("/v1/tenants/:tenantId/integrations/:integrationId/rotate", async (req, reply) => {
    const { integrationId } = parse(integrationParams, req.params);
    serverKey();
    const row = await app.inTenant(req, "integration:manage", async (tx) => {
      const r = await rotateIntegrationSecret(tx, integrationId, (v) => integrationSecretSha256(secretFor(integrationId, v)));
      if (!r) {
        const exists = (await listIntegrations(tx)).some((i) => i.id === integrationId);
        throw exists ? new HttpError(409, "integration_revoked", "a revoked integration cannot be rotated") : notFound("integration");
      }
      await app.audit(req, tx, { action: "integration.rotated", targetType: "integration", targetId: integrationId, metadata: { secretVersion: r.secret_version } });
      return r;
    });
    return reply.header("cache-control", "no-store").send({ integration: toIntegration(row), secret: secretFor(integrationId, row.secret_version) });
  });

  app.post("/v1/tenants/:tenantId/integrations/:integrationId/revoke", async (req) => {
    const { integrationId } = parse(integrationParams, req.params);
    serverKey();
    return app.inTenant(req, "integration:manage", async (tx) => {
      const r = await revokeIntegration(tx, integrationId);
      if (!r) throw notFound("integration");
      if (r.changed) await app.audit(req, tx, { action: "integration.revoked", targetType: "integration", targetId: integrationId });
      return toIntegration(r.row);
    });
  });

  // ── Signed ingestion ──────────────────────────────────────────────────────
  await app.register(async (scope) => {
    // Keep the exact bytes: signatures are computed over the raw body.
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 256 * 1024 }, (req, body, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      try {
        done(null, JSON.parse((body as Buffer).toString("utf8")));
      } catch {
        done(new HttpError(400, "invalid_json", "body is not valid JSON"), undefined);
      }
    });

    scope.post("/v1/integrations/:integrationId/events", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
      serverKey();
      const { integrationId } = parse(z.object({ integrationId: uuid }), req.params);
      const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
      const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
      const audit = (tenantId: string | null, action: string, outcome: "success" | "denied", metadata: Record<string, unknown>) =>
        writeSystemAudit(app.deps.pool, tenantId, {
          actorType: "webhook",
          action,
          outcome,
          targetType: "integration",
          targetId: integrationId,
          metadata: { ...metadata, payloadSha256 },
          requestId: req.id,
          ipHash: hashIp(req.ip),
        }).catch((err) => req.log.warn({ err }, "integration audit failed"));
      const unauthorized = async (tenantId: string | null, reason: string) => {
        await audit(tenantId, "integration.event_rejected", "denied", { reason });
        return new HttpError(401, "invalid_signature", "integration unknown or signature verification failed");
      };

      const integration = await withSystem(app.deps.pool, (tx) => getIntegrationForIngest(tx, integrationId));
      if (!integration) throw await unauthorized(null, "unknown_integration");
      const secret = secretFor(integration.id, integration.secret_version);
      // A changed server key would silently accept nothing; say why (fail closed).
      if (integrationSecretSha256(secret) !== integration.secret_sha256) {
        req.log.error({ integrationId }, "integration secret does not match the server key (was INTEGRATION_SECRET_KEY changed?)");
        throw await unauthorized(integration.tenant_id, "server_key_mismatch");
      }
      const sig = req.headers[SIGNING.header];
      const verified = verifyWebhookSignature({
        header: Array.isArray(sig) ? sig[0] : sig,
        rawBody,
        secrets: [secret],
        toleranceSeconds: env.WEBHOOK_TOLERANCE_SECONDS,
        nowSeconds: Math.floor(app.deps.now().getTime() / 1000),
      });
      if (!verified.ok) throw await unauthorized(integration.tenant_id, verified.reason === "stale" ? "expired_timestamp" : `signature_${verified.reason}`);
      if (integration.status !== "active") {
        await audit(integration.tenant_id, "integration.event_revoked", "denied", { reason: "revoked" });
        throw new HttpError(403, "integration_revoked", "this integration is revoked");
      }

      let event: IntegrationEvent;
      try {
        event = parseIntegrationEvent(req.body, integration.allowed_event_types);
      } catch (e) {
        if (!(e instanceof IntegrationEventRefusal)) throw e;
        await audit(integration.tenant_id, "integration.event_rejected", "denied", { reason: e.code });
        throw new HttpError(422, `integration_event_${e.code}`, e.message);
      }

      const tenantId = integration.tenant_id;
      let stored: Awaited<ReturnType<typeof normalizeIntoPipeline>> | "duplicate";
      try {
        stored = await withTenant(app.deps.pool, tenantId, async (tx) => {
          if (await integrationEventSeen(tx, integration.id, event.id)) return "duplicate" as const;
          const out = await normalizeIntoPipeline(tx, event);
          if (!(await recordIntegrationEvent(tx, { integrationId: integration.id, providerEventId: event.id, eventType: event.type, payloadSha256, rawObservationIds: out.ids }))) {
            throw new Duplicate(); // a concurrent delivery won: roll back everything written here
          }
          if (env.REALTIME_EVENTS_ENABLED && out.sensorId) {
            await appendRealtimeEvent(tx, {
              scheme: "metafarm-event/1",
              type: "sensor.reading.received",
              schemaVersion: 1,
              id: randomUUID(),
              scope: { tenantId, farmId: out.farmId },
              occurredAt: app.deps.now().toISOString(),
              correlationId: `integration:${integration.id}`,
              payload: { sensorId: out.sensorId, rawObservationIds: out.ids, metrics: out.metrics, source: "integration" },
            });
          }
          return out;
        });
      } catch (e) {
        if (e instanceof Duplicate) stored = "duplicate";
        else if (e instanceof HttpError) {
          await audit(tenantId, "integration.event_rejected", "denied", { reason: e.code, eventType: event.type, providerEventId: event.id });
          throw e;
        } else throw e;
      }
      if (stored === "duplicate") {
        await audit(tenantId, "integration.event_replayed", "success", { eventType: event.type, providerEventId: event.id });
        return reply.status(200).send({ status: "duplicate" });
      }
      for (const id of stored.ids) await app.deps.jobs.enqueue(QUEUES.observations, { tenantId, farmId: stored.farmId, rawObservationId: id });
      await audit(tenantId, "integration.event_accepted", "success", { eventType: event.type, providerEventId: event.id, observations: stored.ids.length });
      return reply.status(202).send({ status: "accepted", accepted: stored.ids.length });
    });
  });
}
