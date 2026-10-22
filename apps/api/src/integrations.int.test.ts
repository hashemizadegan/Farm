/**
 * Registered integrations against a real database: registration and rotation by workspace admins, signed ingestion
 * keyed by integration id (HMAC, timestamp tolerance), idempotency per provider event id, workspace resolved from the
 * integration only, refusal of payload workspace identities and of other workspaces' sensors and farms, revocation,
 * audit rows for every outcome, and accepted events reaching the existing observation pipeline.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { QUEUES } from "@metafarm/domain";
import { signWebhook } from "@metafarm/domain/server";
import { buildTestApp, tokenFor } from "./test/helpers";
import type { createMemoryProducer } from "./queue/producer";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const KEY = "integration-key-for-tests-0123456789abcdef";

d("registered integrations", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let jobs: ReturnType<typeof createMemoryProducer>;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { ownerA: `ig-a-${sfx}`, managerA: `ig-m-${sfx}`, ownerB: `ig-b-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantA: string;
  let tenantB: string;
  let farmA: string;
  let farmB: string;
  let sensorA: string;
  let sensorB: string;
  let sensorFeed: { id: string; secret: string };
  const reading = { metric: "soil_moisture", value: 0.21, unit: "fraction_vwc", observedAt: "2026-10-23T01:00:00Z" };
  const auth = async (who: keyof typeof subjects) => ({ authorization: `Bearer ${await tokenFor(subjects[who])}` });
  const now = () => Math.floor(Date.now() / 1000);
  const post = (integrationId: string, secret: string, body: unknown, ts = now()) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return app.inject({
      method: "POST",
      url: `/v1/integrations/${integrationId}/events`,
      headers: { "content-type": "application/json", "x-webhook-signature": signWebhook(secret, raw, ts) },
      payload: raw,
    });
  };
  const readings = (id: string, over: Record<string, unknown> = {}) => ({ scheme: "metafarm-integration-event/1", id, type: "sensor.readings", sensorId: sensorA, readings: [reading, { ...reading, metric: "air_temperature", value: 18, unit: "celsius" }], ...over });
  const register = async (tenantId: string, who: keyof typeof subjects, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/integrations`, headers: await auth(who), payload: body });
  const rawCount = async (sensorId: string) => Number((await pool.query(`SELECT count(*) FROM raw_observations WHERE sensor_id = $1`, [sensorId])).rows[0].count);
  const audits = async (integrationId: string) =>
    (await pool.query<{ action: string; outcome: string; tenant_id: string | null; metadata: Record<string, unknown> }>(`SELECT action, outcome, tenant_id, metadata FROM audit_events WHERE target_type = 'integration' AND target_id = $1 ORDER BY id`, [integrationId])).rows;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 8 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantA = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `ig-a-${sfx}`, name: "IG A", ownerUserId: ids.ownerA! }));
    tenantB = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `ig-b-${sfx}`, name: "IG B", ownerUserId: ids.ownerB! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'manager')`, [tenantA, ids.managerA]);
    const built = await buildTestApp({ pool, env: { INTEGRATION_SECRET_KEY: KEY } });
    app = built.app;
    jobs = built.jobs as ReturnType<typeof createMemoryProducer>;
    farmA = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantA}/farms`, headers: await auth("ownerA"), payload: { name: "IG A1" } })).json().id;
    farmB = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantB}/farms`, headers: await auth("ownerB"), payload: { name: "IG B1" } })).json().id;
    const sensor = async (who: "ownerA" | "ownerB", tenantId: string, farmId: string) =>
      (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms/${farmId}/sensors`, headers: await auth(who), payload: { name: "probe", kind: "soil-moisture" } })).json().sensor.id as string;
    sensorA = await sensor("ownerA", tenantA, farmA);
    sensorB = await sensor("ownerB", tenantB, farmB);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("registers an integration for workspace admins only, shows its secret once and stores only a hash", async () => {
    const body = { kind: "sensor_feed", provider: "acme-probes", name: "Acme probes", allowedEventTypes: ["sensor.readings"] };
    expect((await register(tenantA, "managerA", body)).statusCode).toBe(403);
    expect((await register(tenantA, "ownerA", { ...body, allowedEventTypes: ["observation.reported"] })).statusCode).toBe(400);
    const r = await register(tenantA, "ownerA", body);
    expect(r.statusCode).toBe(201);
    expect(r.headers["cache-control"]).toBe("no-store");
    const { integration, secret, signing } = r.json();
    sensorFeed = { id: integration.id, secret };
    expect(secret).toMatch(/^mfi_[A-Za-z0-9_-]{43}$/);
    expect(integration).toMatchObject({ kind: "sensor_feed", provider: "acme-probes", status: "active", secretVersion: 1, lastSeenAt: null });
    expect(signing).toMatchObject({ header: "x-webhook-signature", url: `/v1/integrations/${integration.id}/events` });
    const row = (await pool.query(`SELECT * FROM integrations WHERE id = $1`, [integration.id])).rows[0];
    expect(row.secret_sha256).toBe(createHash("sha256").update(secret).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(secret.slice(4));
    const list = (await app.inject({ method: "GET", url: `/v1/tenants/${tenantA}/integrations`, headers: await auth("ownerA") })).json().items;
    expect(list.map((i: { id: string }) => i.id)).toContain(integration.id);
    expect(JSON.stringify(list)).not.toContain(secret);
    // Another workspace does not see it.
    const other = (await app.inject({ method: "GET", url: `/v1/tenants/${tenantB}/integrations`, headers: await auth("ownerB") })).json().items;
    expect(other.map((i: { id: string }) => i.id)).not.toContain(integration.id);
  });

  it("rejects a wrong signature, an unknown integration and an expired timestamp before storing anything", async () => {
    const before = await rawCount(sensorA);
    const bad = await post(sensorFeed.id, "mfi_not-the-secret", readings(`bad-${sfx}`));
    expect([bad.statusCode, bad.json().error]).toEqual([401, "invalid_signature"]);
    expect((await post(randomUUID(), sensorFeed.secret, readings(`unknown-${sfx}`))).statusCode).toBe(401);
    const stale = await post(sensorFeed.id, sensorFeed.secret, readings(`stale-${sfx}`), now() - 3_600);
    expect(stale.statusCode).toBe(401);
    expect(await rawCount(sensorA)).toBe(before);
    expect((await pool.query(`SELECT 1 FROM integration_events WHERE integration_id = $1`, [sensorFeed.id])).rowCount).toBe(0);
    const reasons = (await audits(sensorFeed.id)).filter((a) => a.action === "integration.event_rejected").map((a) => [a.tenant_id, a.metadata.reason]);
    expect(reasons).toEqual([
      [tenantA, "signature_mismatch"],
      [tenantA, "expired_timestamp"],
    ]);
  });

  it("accepts a signed event into the existing observation pipeline, once; a replay is harmless", async () => {
    const id = `ok-${sfx}`;
    const r = await post(sensorFeed.id, sensorFeed.secret, readings(id));
    expect([r.statusCode, r.json()]).toEqual([202, { status: "accepted", accepted: 2 }]);
    const raw = (await pool.query(`SELECT tenant_id, farm_id, provenance_label, status FROM raw_observations WHERE sensor_id = $1`, [sensorA])).rows;
    expect(raw).toHaveLength(2);
    expect(raw.every((x) => x.tenant_id === tenantA && x.farm_id === farmA && x.provenance_label === "provider-observation")).toBe(true);
    const queued = jobs.jobs.filter((j) => j.queue === QUEUES.observations && (j.payload as { tenantId: string }).tenantId === tenantA);
    expect(queued).toHaveLength(2);

    // Redelivered (new timestamp, same provider event id): nothing more is stored or queued.
    const again = await post(sensorFeed.id, sensorFeed.secret, readings(id), now() + 1);
    expect([again.statusCode, again.json()]).toEqual([200, { status: "duplicate" }]);
    expect(await rawCount(sensorA)).toBe(2);
    expect(jobs.jobs.filter((j) => j.queue === QUEUES.observations && (j.payload as { tenantId: string }).tenantId === tenantA)).toHaveLength(2);

    // Two deliveries racing: exactly one is stored.
    const race = `race-${sfx}`;
    const results = await Promise.all([post(sensorFeed.id, sensorFeed.secret, readings(race)), post(sensorFeed.id, sensorFeed.secret, readings(race))]);
    expect(results.map((x) => x.statusCode).sort()).toEqual([200, 202]);
    expect(await rawCount(sensorA)).toBe(4);

    const actions = (await audits(sensorFeed.id)).map((a) => a.action);
    expect(actions.filter((a) => a === "integration.event_accepted")).toHaveLength(2);
    expect(actions.filter((a) => a === "integration.event_replayed")).toHaveLength(2);
    const seen = (await pool.query(`SELECT last_seen_at FROM integrations WHERE id = $1`, [sensorFeed.id])).rows[0].last_seen_at;
    expect(seen).not.toBeNull();
  });

  it("takes the workspace from the integration only: payload workspaces and other workspaces' sensors are refused", async () => {
    const beforeA = await rawCount(sensorA);
    const beforeB = await rawCount(sensorB);
    for (const body of [readings(`ws1-${sfx}`, { tenantId: tenantB }), readings(`ws2-${sfx}`, { readings: [{ ...reading, workspaceId: tenantB }] })]) {
      const r = await post(sensorFeed.id, sensorFeed.secret, body);
      expect([r.statusCode, r.json().error]).toEqual([422, "integration_event_workspace_in_payload"]);
    }
    const cross = await post(sensorFeed.id, sensorFeed.secret, readings(`cross-${sfx}`, { sensorId: sensorB }));
    expect([cross.statusCode, cross.json().error]).toEqual([422, "integration_event_unknown_sensor"]);
    const wrongType = await post(sensorFeed.id, sensorFeed.secret, { scheme: "metafarm-integration-event/1", id: `obs-${sfx}`, type: "observation.reported", farmId: farmA, observations: [reading] });
    expect([wrongType.statusCode, wrongType.json().error]).toEqual([422, "integration_event_event_type_not_allowed"]);
    expect([await rawCount(sensorA), await rawCount(sensorB)]).toEqual([beforeA, beforeB]);
    // Nothing for these events was recorded, so a corrected delivery under the same id is still accepted.
    expect((await pool.query(`SELECT 1 FROM integration_events WHERE provider_event_id = ANY($1)`, [[`ws1-${sfx}`, `cross-${sfx}`]])).rowCount).toBe(0);
    const reasons = (await audits(sensorFeed.id)).filter((a) => a.action === "integration.event_rejected").map((a) => a.metadata.reason);
    expect(reasons).toEqual(expect.arrayContaining(["workspace_in_payload", "integration_event_unknown_sensor", "event_type_not_allowed"]));
  });

  it("observation feeds post to farms of their own workspace only", async () => {
    const r = await register(tenantA, "ownerA", { kind: "observation_feed", provider: "acme-scouting", name: "Scouting", allowedEventTypes: ["observation.reported"] });
    const feed = { id: r.json().integration.id as string, secret: r.json().secret as string };
    const body = (id: string, farmId: string) => ({ scheme: "metafarm-integration-event/1", id, type: "observation.reported", farmId, observations: [{ ...reading, metric: "note", value: "dry patch near the gate" }] });
    const foreign = await post(feed.id, feed.secret, body(`f1-${sfx}`, farmB));
    expect([foreign.statusCode, foreign.json().error]).toEqual([422, "integration_event_unknown_farm"]);
    const ok = await post(feed.id, feed.secret, body(`f2-${sfx}`, farmA));
    expect([ok.statusCode, ok.json().accepted]).toEqual([202, 1]);
    const rows = (await pool.query(`SELECT r.tenant_id, r.farm_id FROM raw_observations r JOIN integration_events e ON r.id = ANY(e.raw_observation_ids) WHERE e.integration_id = $1`, [feed.id])).rows;
    expect(rows).toEqual([{ tenant_id: tenantA, farm_id: farmA }]);
  });

  it("rotates the secret (the old one stops at once) and revocation is final", async () => {
    const base = `/v1/tenants/${tenantA}/integrations/${sensorFeed.id}`;
    expect((await app.inject({ method: "POST", url: `${base}/rotate`, headers: await auth("managerA") })).statusCode).toBe(403);
    const rotated = await app.inject({ method: "POST", url: `${base}/rotate`, headers: await auth("ownerA") });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().integration).toMatchObject({ secretVersion: 2 });
    const fresh = rotated.json().secret as string;
    expect(fresh).not.toBe(sensorFeed.secret);
    expect((await post(sensorFeed.id, sensorFeed.secret, readings(`old-${sfx}`))).statusCode).toBe(401);
    expect((await post(sensorFeed.id, fresh, readings(`new-${sfx}`))).statusCode).toBe(202);

    const revoked = await app.inject({ method: "POST", url: `${base}/revoke`, headers: await auth("ownerA") });
    expect(revoked.json()).toMatchObject({ status: "revoked" });
    const r = await post(sensorFeed.id, fresh, readings(`after-${sfx}`));
    expect([r.statusCode, r.json().error]).toEqual([403, "integration_revoked"]);
    expect((await app.inject({ method: "POST", url: `${base}/rotate`, headers: await auth("ownerA") })).statusCode).toBe(409);
    await expect(pool.query(`UPDATE integrations SET status = 'active', revoked_at = NULL WHERE id = $1`, [sensorFeed.id])).rejects.toThrow(/stays revoked/);
    const actions = (await audits(sensorFeed.id)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["integration.registered", "integration.rotated", "integration.revoked", "integration.event_revoked"]));
    // Another workspace cannot revoke or rotate it (not found).
    expect((await app.inject({ method: "POST", url: `/v1/tenants/${tenantB}/integrations/${sensorFeed.id}/revoke`, headers: await auth("ownerB") })).statusCode).toBe(404);
  });
});
