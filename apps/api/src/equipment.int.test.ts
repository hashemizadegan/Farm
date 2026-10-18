/** Equipment against a real database: readings, maintenance due by hours/days, services resetting plans, and tasks. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("equipment and maintenance", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `e-owner-${sfx}`, worker: `e-worker-${sfx}`, viewer: `e-viewer-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let farmId: string;
  let tractorId: string;
  let planId: string;
  const auth = async (who: keyof typeof subjects) => ({ authorization: `Bearer ${await tokenFor(subjects[who])}` });
  const base = () => `/v1/tenants/${tenantId}/equipment`;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `eq-${sfx}`, name: "Eq", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'worker'), ($1, $3, 'viewer')`, [tenantId, ids.worker, ids.viewer]);
    ({ app } = await buildTestApp({ pool, deps: { now: () => new Date("2026-10-18T09:00:00Z") } }));
    farmId = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: await auth("owner"), payload: { name: "Eq farm" } })).json().id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("lets managers add machines with a starting hour meter", async () => {
    const payload = { name: "MF 285", kind: "tractor", farmId, tracksHours: true, currentHours: "1200" };
    expect((await app.inject({ method: "POST", url: base(), headers: await auth("worker"), payload })).statusCode).toBe(403);
    const r = await app.inject({ method: "POST", url: base(), headers: await auth("owner"), payload });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ currentHours: "1200", farmName: "Eq farm" });
    tractorId = r.json().id;
  });

  it("accepts readings from workers but never a lower one", async () => {
    const add = (hours: string) => auth("worker").then((headers) => app.inject({ method: "POST", url: `${base()}/${tractorId}/readings`, headers, payload: { hours, readOn: "2026-10-18" } }));
    expect((await add("1199")).statusCode).toBe(409);
    expect((await add("1240.5")).json().currentHours).toBe("1240.5");
  });

  it("computes maintenance due by hours and turns it into a task", async () => {
    const plan = await app.inject({
      method: "POST",
      url: `${base()}/${tractorId}/plans`,
      headers: await auth("owner"),
      payload: { title: "Engine oil", everyHours: 50, everyDays: 180, lastDoneOn: "2026-06-01", lastDoneHours: "1190" },
    });
    expect(plan.json().due).toEqual({ state: "overdue", dueOn: "2026-11-28", dueHours: 1240 });
    planId = plan.json().id;
    const list = (await app.inject({ method: "GET", url: base(), headers: await auth("viewer") })).json().items;
    expect(list[0].maintenance).toEqual({ overdue: 1, soon: 0, state: "overdue" });

    const task = await app.inject({ method: "POST", url: `${base()}/${tractorId}/plans/${planId}/task`, headers: await auth("owner"), payload: { assigneeUserId: ids.worker } });
    expect(task.statusCode).toBe(201);
    expect(task.json()).toMatchObject({ title: "Engine oil: MF 285", kind: "maintenance", priority: "high", dueDate: "2026-10-18", farmId });
  });

  it("resets the plan when the service is recorded", async () => {
    const s = await app.inject({
      method: "POST",
      url: `${base()}/${tractorId}/services`,
      headers: await auth("worker"),
      payload: { planId, doneOn: "2026-10-18", hours: "1241", description: "Oil and filter changed", cost: "35", currency: "USD" },
    });
    expect(s.json().currentHours).toBe("1241");
    const detail = (await app.inject({ method: "GET", url: `${base()}/${tractorId}`, headers: await auth("viewer") })).json();
    expect(detail.plans[0]).toMatchObject({ lastDoneOn: "2026-10-18", lastDoneHours: "1241", due: { state: "ok", dueHours: 1291 } });
    expect(detail.services[0]).toMatchObject({ planTitle: "Engine oil", description: "Oil and filter changed", cost: "35.00", currency: "USD" });
  });
});
