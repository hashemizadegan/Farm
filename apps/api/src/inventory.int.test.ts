/**
 * Inputs and stock against a real database: permissions, exact stock sums,
 * inputs recorded when a task is completed, and pre-harvest interval checks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("inputs and stock", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `i-owner-${sfx}`, worker: `i-worker-${sfx}`, viewer: `i-viewer-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let farmId: string;
  let itemId: string;
  const auth = async (who: keyof typeof subjects) => ({ authorization: `Bearer ${await tokenFor(subjects[who])}` });
  const inv = () => `/v1/tenants/${tenantId}/inventory`;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `inv-${sfx}`, name: "Inv", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'worker'), ($1, $3, 'viewer')`, [tenantId, ids.worker, ids.viewer]);
    ({ app } = await buildTestApp({ pool, deps: { now: () => new Date("2026-10-18T09:00:00Z") } }));
    farmId = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: await auth("owner"), payload: { name: "Inv farm" } })).json().id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("lets managers add items, and refuses duplicates", async () => {
    const payload = { name: "Copper oxychloride", category: "crop-protection", unit: "kg", reorderLevel: "5", preHarvestIntervalDays: 14 };
    expect((await app.inject({ method: "POST", url: `${inv()}/items`, headers: await auth("worker"), payload })).statusCode).toBe(403);
    const r = await app.inject({ method: "POST", url: `${inv()}/items`, headers: await auth("owner"), payload });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ onHand: "0", lowStock: true });
    itemId = r.json().id;
    expect((await app.inject({ method: "POST", url: `${inv()}/items`, headers: await auth("owner"), payload: { ...payload, name: "copper OXYCHLORIDE" } })).statusCode).toBe(409);
  });

  it("keeps exact stock: deliveries by managers, use by workers, corrections with a reason", async () => {
    const move = (who: keyof typeof subjects, payload: object) => auth(who).then((headers) => app.inject({ method: "POST", url: `${inv()}/movements`, headers, payload }));
    expect((await move("worker", { kind: "receive", itemId, quantity: "10", occurredOn: "2026-10-01" })).statusCode).toBe(403);
    expect((await move("owner", { kind: "receive", itemId, quantity: "10.1", occurredOn: "2026-10-01", cost: "120.50" })).statusCode).toBe(400);
    expect((await move("owner", { kind: "receive", itemId, quantity: "10.1", occurredOn: "2026-10-01", cost: "120.50", currency: "IRR", supplier: "Co-op" })).statusCode).toBe(201);
    const used = await move("worker", { kind: "use", itemId, quantity: "0.2", occurredOn: "2026-10-10", farmId, parcelLabel: "Block 3" });
    expect(used.statusCode).toBe(201);
    expect(used.json().item.onHand).toBe("9.9");
    expect((await move("viewer", { kind: "use", itemId, quantity: "1", occurredOn: "2026-10-10", farmId })).statusCode).toBe(403);
    const adj = await move("owner", { kind: "adjust", itemId, quantity: "-0.9", occurredOn: "2026-10-12", note: "stock count" });
    expect(adj.json().item).toMatchObject({ onHand: "9", lowStock: false });
  });

  it("refuses edits to the movement log at the database level", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE metafarm_app");
      await expect(c.query(`UPDATE stock_movements SET quantity = 1 WHERE tenant_id = $1`, [tenantId])).rejects.toThrow(/permission denied/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("records inputs used when a task is completed, on the task's parcel", async () => {
    const task = (
      await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/farms/${farmId}/tasks`,
        headers: await auth("owner"),
        payload: { title: "Spray block 3", kind: "spraying", dueDate: "2026-10-18", parcelLabel: "Block 3", assigneeUserId: ids.worker },
      })
    ).json();
    const done = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/farms/${farmId}/tasks/${task.id}/complete`,
      headers: await auth("worker"),
      payload: { inputs: [{ itemId, quantity: "1.5" }] },
    });
    expect(done.statusCode).toBe(200);
    const log = (await app.inject({ method: "GET", url: `${inv()}/movements?farmId=${farmId}&kind=use`, headers: await auth("viewer") })).json().items;
    expect(log[0]).toMatchObject({ quantity: "-1.5", parcelLabel: "Block 3", taskId: task.id, taskTitle: "Spray block 3", occurredOn: "2026-10-18" });
  });

  it("reports running pre-harvest intervals for the parcel", async () => {
    const phi = (q: string) => auth("viewer").then((headers) => app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/farms/${farmId}/phi?${q}`, headers }));
    const blocked = (await phi("parcel=Block%203&on=2026-10-20")).json().items;
    expect(blocked).toEqual([expect.objectContaining({ itemName: "Copper oxychloride", appliedOn: "2026-10-18", harvestAllowedFrom: "2026-11-01" })]);
    expect((await phi("parcel=Block%203&on=2026-11-01")).json().items).toEqual([]);
    expect((await phi("parcel=Block%209&on=2026-10-20")).json().items).toEqual([]);
  });
});
