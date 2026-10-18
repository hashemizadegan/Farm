/** Notifications against a real database: who receives what, once, and only their own. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("notifications", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `o-owner-${sfx}`, worker: `o-worker-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let farmId: string;
  const auth = async (who: keyof typeof subjects) => ({ authorization: `Bearer ${await tokenFor(subjects[who])}` });
  const inbox = async (who: keyof typeof subjects) => (await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/notifications`, headers: await auth(who) })).json();

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `notif-${sfx}`, name: "Notif", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'worker')`, [tenantId, ids.worker]);
    ({ app } = await buildTestApp({ pool }));
    farmId = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: await auth("owner"), payload: { name: "Notif farm" } })).json().id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("tells a worker about a task given to them, once", async () => {
    const task = (
      await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/farms/${farmId}/tasks`,
        headers: await auth("owner"),
        payload: { title: "Prune row 4", kind: "pruning", dueDate: "2026-10-20", assigneeUserId: ids.worker },
      })
    ).json();
    // Changing something else does not repeat the notification.
    await app.inject({ method: "PATCH", url: `/v1/tenants/${tenantId}/farms/${farmId}/tasks/${task.id}`, headers: await auth("owner"), payload: { priority: "high" } });
    const w = await inbox("worker");
    expect(w.unread).toBe(1);
    expect(w.items[0]).toMatchObject({ kind: "task_assigned", read: false, data: { taskId: task.id, title: "Prune row 4", farmName: "Notif farm", dueDate: "2026-10-20" } });
    expect((await inbox("owner")).items).toHaveLength(0);

    const r = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/notifications/read`, headers: await auth("worker"), payload: { all: true } });
    expect(r.json().marked).toBe(1);
    expect((await inbox("worker")).unread).toBe(0);
  });

  it("tells stock managers when use takes an item to its reorder level, once per crossing", async () => {
    const item = (
      await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/inventory/items`, headers: await auth("owner"), payload: { name: "Urea", category: "fertilizer", unit: "kg", reorderLevel: "5" } })
    ).json();
    const move = async (who: keyof typeof subjects, payload: object) =>
      app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/inventory/movements`, headers: await auth(who), payload: { itemId: item.id, occurredOn: "2026-10-18", ...payload } });
    await move("owner", { kind: "receive", quantity: "8" });
    await move("worker", { kind: "use", quantity: "2", farmId });
    expect((await inbox("owner")).items.filter((n: { kind: string }) => n.kind === "low_stock")).toHaveLength(0);
    await move("worker", { kind: "use", quantity: "1", farmId });
    await move("worker", { kind: "use", quantity: "1", farmId });
    const low = (await inbox("owner")).items.filter((n: { kind: string }) => n.kind === "low_stock");
    expect(low).toHaveLength(1);
    expect(low[0].data).toMatchObject({ itemName: "Urea", onHand: "5", unit: "kg" });
    // Workers do not order stock, so they are not told.
    expect((await inbox("worker")).items.filter((n: { kind: string }) => n.kind === "low_stock")).toHaveLength(0);
  });
});
