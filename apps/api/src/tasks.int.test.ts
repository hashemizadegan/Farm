/**
 * Field tasks against a real database: who may create, start and complete
 * tasks, and how repeating tasks schedule their next occurrence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("field tasks", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `t-owner-${sfx}`, worker: `t-worker-${sfx}`, worker2: `t-worker2-${sfx}`, viewer: `t-viewer-${sfx}`, outsider: `t-out-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let farmId: string;
  const auth = async (who: keyof typeof subjects) => ({ authorization: `Bearer ${await tokenFor(subjects[who])}` });
  const base = () => `/v1/tenants/${tenantId}/farms/${farmId}/tasks`;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `tasks-${sfx}`, name: "Tasks", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'worker'), ($1, $3, 'worker'), ($1, $4, 'viewer')`, [
      tenantId,
      ids.worker,
      ids.worker2,
      ids.viewer,
    ]);
    // Fixed clock: 2026-10-17 12:00 UTC.
    ({ app } = await buildTestApp({ pool, deps: { now: () => new Date("2026-10-17T12:00:00Z") } }));
    const r = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: await auth("owner"), payload: { name: "Task farm", timezone: "UTC" } });
    farmId = r.json().id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("lets managers create tasks but not workers or viewers", async () => {
    const payload = { title: "Irrigate block A", kind: "irrigation", dueDate: "2026-10-17", assigneeUserId: ids.worker, repeatEveryDays: 3 };
    expect((await app.inject({ method: "POST", url: base(), headers: await auth("worker"), payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: base(), headers: await auth("viewer"), payload })).statusCode).toBe(403);
    const r = await app.inject({ method: "POST", url: base(), headers: await auth("owner"), payload });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ title: "Irrigate block A", status: "todo", dueDate: "2026-10-17", assigneeUserId: ids.worker, farmName: "Task farm" });
  });

  it("rejects assignees outside the workspace", async () => {
    const r = await app.inject({
      method: "POST",
      url: base(),
      headers: await auth("owner"),
      payload: { title: "x", kind: "other", dueDate: "2026-10-18", assigneeUserId: ids.outsider },
    });
    expect(r.statusCode).toBe(400);
  });

  it("lets the assigned worker start and complete their task, which repeats on schedule", async () => {
    const task = (await app.inject({ method: "GET", url: `${base()}?assignee=me`, headers: await auth("worker") })).json().items[0];
    expect(task.title).toBe("Irrigate block A");

    // Another worker cannot touch it, and a worker cannot reschedule.
    expect((await app.inject({ method: "PATCH", url: `${base()}/${task.id}`, headers: await auth("worker2"), payload: { status: "in_progress" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `${base()}/${task.id}`, headers: await auth("worker"), payload: { dueDate: "2026-10-30" } })).statusCode).toBe(403);

    const started = await app.inject({ method: "PATCH", url: `${base()}/${task.id}`, headers: await auth("worker"), payload: { status: "in_progress" } });
    expect(started.json().status).toBe("in_progress");

    const done = await app.inject({ method: "POST", url: `${base()}/${task.id}/complete`, headers: await auth("worker"), payload: { note: "2 hours, drip lines checked" } });
    expect(done.statusCode).toBe(200);
    expect(done.json().task).toMatchObject({ status: "done", completionNote: "2 hours, drip lines checked" });
    expect(done.json().next).toMatchObject({ status: "todo", dueDate: "2026-10-20", assigneeUserId: ids.worker, previousTaskId: task.id });

    // Completing twice is refused and never creates a second follow-up.
    expect((await app.inject({ method: "POST", url: `${base()}/${task.id}/complete`, headers: await auth("worker"), payload: {} })).statusCode).toBe(409);
    const all = (await app.inject({ method: "GET", url: `${base()}?status=all`, headers: await auth("owner") })).json().items;
    expect(all.filter((t: { previousTaskId: string | null }) => t.previousTaskId === task.id)).toHaveLength(1);
  });

  it("lets a worker take an unassigned task by starting it", async () => {
    const created = (
      await app.inject({ method: "POST", url: base(), headers: await auth("owner"), payload: { title: "Scout for pests", kind: "scouting", dueDate: "2026-10-18" } })
    ).json();
    const r = await app.inject({ method: "PATCH", url: `${base()}/${created.id}`, headers: await auth("worker2"), payload: { status: "in_progress" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().assigneeUserId).toBe(ids.worker2);
  });

  it("lists the team schedule across farms within a range, with overdue work", async () => {
    await app.inject({ method: "POST", url: base(), headers: await auth("owner"), payload: { title: "Old job", kind: "other", dueDate: "2026-10-01" } });
    const week = (
      await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/tasks?from=2026-10-17&to=2026-10-23&includeOverdue=true`, headers: await auth("viewer") })
    ).json().items as { title: string; dueDate: string }[];
    expect(week.map((t) => t.title)).toEqual(expect.arrayContaining(["Old job", "Irrigate block A", "Scout for pests"]));
    const bad = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/tasks?from=2026-01-01&to=2026-12-31`, headers: await auth("viewer") });
    expect(bad.statusCode).toBe(400);
  });

  it("keeps tasks inside their workspace", async () => {
    const r = await app.inject({ method: "GET", url: base(), headers: await auth("outsider") });
    expect(r.statusCode).toBe(404);
  });
});
