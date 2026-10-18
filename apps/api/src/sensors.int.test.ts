/** Live sensors against a real database: device tokens, ingestion, rotation, disabling and alert rules. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("live sensors", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let jobs: Awaited<ReturnType<typeof buildTestApp>>["jobs"];
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `n-owner-${sfx}`, worker: `n-worker-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let farmId: string;
  let sensorId: string;
  let token: string;
  const auth = async (who: keyof typeof subjects) => ({ authorization: `Bearer ${await tokenFor(subjects[who])}` });
  const base = () => `/v1/tenants/${tenantId}/farms/${farmId}`;
  const reading = { metric: "soil_moisture", value: 0.18, unit: "fraction_vwc", observedAt: "2026-10-18T06:00:00Z" };
  const ingest = (t: string, readings: object[] = [reading]) =>
    app.inject({ method: "POST", url: "/v1/ingest/readings", headers: { authorization: `Sensor ${t}` }, payload: { readings } });

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `sens-${sfx}`, name: "Sens", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'worker')`, [tenantId, ids.worker]);
    ({ app, jobs } = await buildTestApp({ pool }));
    farmId = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: await auth("owner"), payload: { name: "Sensor farm" } })).json().id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("registers a sensor and shows its token once", async () => {
    const payload = { name: "Block 1 probe", kind: "soil-moisture", parcelLabel: "Block 1", location: { lon: 56.0, lat: 30.4 } };
    expect((await app.inject({ method: "POST", url: `${base()}/sensors`, headers: await auth("worker"), payload })).statusCode).toBe(403);
    const r = await app.inject({ method: "POST", url: `${base()}/sensors`, headers: await auth("owner"), payload });
    expect(r.statusCode).toBe(201);
    expect(r.headers["cache-control"]).toBe("no-store");
    ({ token } = r.json());
    sensorId = r.json().sensor.id;
    expect(token).toMatch(/^mfs_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
    expect(r.json().sensor).toMatchObject({ state: "waiting", location: { lon: 56, lat: 30.4 } });
    const stored = (await pool.query(`SELECT credential_hash FROM sensors WHERE id = $1`, [sensorId])).rows[0].credential_hash;
    expect(stored).not.toContain(token.slice(-43));
  });

  it("accepts readings with the token and queues them as sensor-reported", async () => {
    const r = await ingest(token, [reading, { ...reading, metric: "air_temperature", value: 64, unit: "fahrenheit" }]);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ accepted: 2 });
    expect(jobs.jobs.filter((j) => j.queue === "observation-normalization")).toHaveLength(2);
    const raw = (await pool.query(`SELECT provenance_label, sensor_id FROM raw_observations WHERE tenant_id = $1`, [tenantId])).rows;
    expect(raw.every((x) => x.provenance_label === "sensor-reported" && x.sensor_id === sensorId)).toBe(true);
    const list = (await app.inject({ method: "GET", url: `${base()}/sensors`, headers: await auth("worker") })).json().items;
    expect(list[0].state).toBe("online");
  });

  it("rejects wrong, malformed and rotated tokens, and disabled sensors", async () => {
    expect((await ingest(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).statusCode).toBe(401);
    expect((await ingest("nonsense")).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/ingest/readings", payload: { readings: [reading] } })).statusCode).toBe(401);
    expect((await ingest(token, [{ ...reading, metric: "note" }])).statusCode).toBe(400);

    const rotated = (await app.inject({ method: "POST", url: `${base()}/sensors/${sensorId}/rotate`, headers: await auth("owner") })).json().token;
    expect((await ingest(token)).statusCode).toBe(401);
    expect((await ingest(rotated)).statusCode).toBe(202);

    await app.inject({ method: "PATCH", url: `${base()}/sensors/${sensorId}`, headers: await auth("owner"), payload: { status: "disabled" } });
    expect((await ingest(rotated)).statusCode).toBe(401);
  });

  it("lets managers add and switch off alert rules", async () => {
    const rule = { metric: "soil_moisture", comparator: "lt", threshold: 15, severity: "warning", consecutive: 2 };
    expect((await app.inject({ method: "POST", url: `${base()}/alert-rules`, headers: await auth("worker"), payload: rule })).statusCode).toBe(403);
    const r = await app.inject({ method: "POST", url: `${base()}/alert-rules`, headers: await auth("owner"), payload: rule });
    expect(r.json()).toMatchObject({ ...rule, windowMinutes: 60, enabled: true });
    const off = await app.inject({ method: "PATCH", url: `${base()}/alert-rules/${r.json().id}`, headers: await auth("owner"), payload: { enabled: false } });
    expect(off.json().enabled).toBe(false);
  });
});
