/** Resends from an offline queue: the same Idempotency-Key never records twice. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("offline resends", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let jobs: Awaited<ReturnType<typeof buildTestApp>>["jobs"];
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `q-owner-${sfx}`, worker: `q-worker-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let farmId: string;
  const send = async (who: keyof typeof subjects, method: "POST", path: string, payload: object, key?: string) =>
    app.inject({
      method,
      url: `/v1/tenants/${tenantId}/farms/${farmId}${path}`,
      headers: { authorization: `Bearer ${await tokenFor(subjects[who])}`, ...(key ? { "idempotency-key": key } : {}) },
      payload,
    });

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `off-${sfx}`, name: "Off", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'worker')`, [tenantId, ids.worker]);
    ({ app, jobs } = await buildTestApp({ pool }));
    farmId = (
      await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/farms`,
        headers: { authorization: `Bearer ${await tokenFor(subjects.owner)}` },
        payload: { name: "Offline farm" },
      })
    ).json().id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("records a resent harvest once and returns the original", async () => {
    const key = randomUUID();
    const batch = { cropName: "Saffron", harvestedOn: "2026-10-15", quantity: "1.2", unit: "kg" };
    const first = await send("worker", "POST", "/harvests", batch, key);
    expect(first.statusCode).toBe(201);
    const again = await send("worker", "POST", "/harvests", batch, key);
    expect(again.statusCode).toBe(200);
    expect(again.json().code).toBe(first.json().code);
    const n = await pool.query(`SELECT count(*)::int AS n FROM harvest_batches WHERE tenant_id = $1`, [tenantId]);
    expect(n.rows[0].n).toBe(1);
    // Someone else cannot use the key to read the batch.
    expect((await send("owner", "POST", "/harvests", batch, key)).statusCode).toBe(409);
    expect((await send("worker", "POST", "/harvests", batch, "not-a-uuid")).statusCode).toBe(400);
  });

  it("queues a resent observation once", async () => {
    const key = randomUUID();
    const obs = { metric: "soil_moisture", value: 0.21, unit: "fraction_vwc", observedAt: "2026-10-15T07:00:00Z" };
    const before = jobs.jobs.length;
    const a = await send("worker", "POST", "/observations", obs, key);
    const b = await send("worker", "POST", "/observations", obs, key);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(b.json().rawObservationId).toBe(a.json().rawObservationId);
    expect(jobs.jobs.length - before).toBe(1);
  });

  it("answers a resent task completion as the first time, and still refuses a different one", async () => {
    const task = (await send("owner", "POST", "/tasks", { title: "Irrigate", kind: "irrigation", dueDate: "2026-10-15", repeatEveryDays: 7, assigneeUserId: ids.worker })).json();
    const key = randomUUID();
    const first = await send("worker", "POST", `/tasks/${task.id}/complete`, { note: "done in the field" }, key);
    expect(first.statusCode).toBe(200);
    const again = await send("worker", "POST", `/tasks/${task.id}/complete`, { note: "done in the field" }, key);
    expect(again.statusCode).toBe(200);
    expect(again.json().next.id).toBe(first.json().next.id);
    const repeats = await pool.query(`SELECT count(*)::int AS n FROM farm_tasks WHERE tenant_id = $1 AND previous_task_id = $2`, [tenantId, task.id]);
    expect(repeats.rows[0].n).toBe(1);
    expect((await send("worker", "POST", `/tasks/${task.id}/complete`, {}, randomUUID())).statusCode).toBe(409);
  });
});
