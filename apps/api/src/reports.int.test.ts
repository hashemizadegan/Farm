/** Period reports against a real database: totals from recorded work, per farm and for the workspace. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

d("period reports", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `r-owner-${sfx}`, worker: `r-worker-${sfx}`, outsider: `r-out-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let farmA: string;
  let farmB: string;
  const auth = async (who: keyof typeof subjects) => ({ authorization: `Bearer ${await tokenFor(subjects[who])}` });
  const post = async (who: keyof typeof subjects, path: string, payload: object) =>
    app.inject({ method: "POST", url: `/v1/tenants/${tenantId}${path}`, headers: await auth(who), payload });
  const report = async (who: keyof typeof subjects, query: string) =>
    app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/reports/summary?${query}`, headers: await auth(who) });

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `rep-${sfx}`, name: "Rep", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'worker')`, [tenantId, ids.worker]);
    await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `rep-o-${sfx}`, name: "Other", ownerUserId: ids.outsider! }));
    ({ app } = await buildTestApp({ pool }));
    farmA = (await post("owner", "/farms", { name: "North orchard" })).json().id;
    farmB = (await post("owner", "/farms", { name: "South field" })).json().id;

    const today = day(0);
    for (const title of ["Prune row 1", "Prune row 2"]) {
      const t = (await post("owner", `/farms/${farmA}/tasks`, { title, kind: "pruning", dueDate: today, assigneeUserId: ids.worker })).json();
      expect((await post("worker", `/farms/${farmA}/tasks/${t.id}/complete`, {})).statusCode).toBe(200);
    }
    await post("owner", `/farms/${farmA}/tasks`, { title: "Irrigate", kind: "irrigation", dueDate: today });

    const item = (await post("owner", "/inventory/items", { name: "Urea", category: "fertilizer", unit: "kg" })).json();
    await post("owner", "/inventory/movements", { itemId: item.id, kind: "receive", quantity: "50", occurredOn: today, cost: "120", currency: "USD" });
    await post("worker", "/inventory/movements", { itemId: item.id, kind: "use", quantity: "2.5", occurredOn: today, farmId: farmA });
    await post("worker", "/inventory/movements", { itemId: item.id, kind: "use", quantity: "1", occurredOn: today, farmId: farmA });

    await post("worker", `/farms/${farmA}/harvests`, { cropName: "Pistachio", harvestedOn: today, quantity: "120.5", unit: "kg" });
    await post("worker", `/farms/${farmA}/harvests`, { cropName: "Pistachio", harvestedOn: today, quantity: "80", unit: "kg" });
    const voided = (await post("worker", `/farms/${farmA}/harvests`, { cropName: "Pistachio", harvestedOn: today, quantity: "999", unit: "kg" })).json();
    await post("owner", `/farms/${farmA}/harvests/${voided.id}/void`, { reason: "Entered twice" });

    const tractor = (await post("owner", "/equipment", { name: "MF 285", kind: "tractor", farmId: farmA, tracksHours: false })).json();
    await post("worker", `/equipment/${tractor.id}/services`, { doneOn: today, description: "Oil change", cost: "35", currency: "USD" });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("totals the workspace", async () => {
    const r = await report("worker", `from=${day(-3)}&to=${day(3)}`);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.farm).toBeNull();
    expect(b.tasks).toMatchObject({ completed: 2, due: 3, dueStillOpen: 1, byKind: [{ kind: "pruning", count: 2 }] });
    expect(b.tasks.byPerson).toEqual([{ userId: ids.worker, name: expect.any(String), count: 2 }]);
    expect(b.inputs).toEqual([expect.objectContaining({ name: "Urea", unit: "kg", used: "3.5", applications: 2 })]);
    expect(b.harvests).toEqual([{ crop: "Pistachio", unit: "kg", quantity: "200.5", batches: 2 }]);
    expect(b.spending).toEqual({ deliveries: [{ currency: "USD", amount: "120", entries: 1 }], servicing: [{ currency: "USD", amount: "35", entries: 1 }] });
    expect(b.farms).toEqual([
      { farmId: farmA, name: "North orchard", tasksCompleted: 2, applications: 2, harvestBatches: 2, alerts: 0 },
      { farmId: farmB, name: "South field", tasksCompleted: 0, applications: 0, harvestBatches: 0, alerts: 0 },
    ]);
  });

  it("narrows to one farm, where unassigned deliveries do not count", async () => {
    const a = (await report("owner", `farmId=${farmA}&from=${day(-3)}&to=${day(3)}`)).json();
    expect(a.farm).toEqual({ id: farmA, name: "North orchard" });
    expect(a.spending).toEqual({ deliveries: [], servicing: [{ currency: "USD", amount: "35", entries: 1 }] });
    const b = (await report("owner", `farmId=${farmB}&from=${day(-3)}&to=${day(3)}`)).json();
    expect(b.tasks.completed).toBe(0);
    expect(b.harvests).toEqual([]);
    expect(b.farms).toHaveLength(1);
  });

  it("leaves out other periods", async () => {
    const r = (await report("owner", `from=${day(-30)}&to=${day(-10)}`)).json();
    expect(r.tasks.completed).toBe(0);
    expect(r.inputs).toEqual([]);
    expect(r.spending.servicing).toEqual([]);
  });

  it("validates and keeps to members", async () => {
    expect((await report("owner", `from=${day(1)}&to=${day(0)}`)).statusCode).toBe(400);
    expect((await report("owner", "from=2024-01-01&to=2025-06-01")).statusCode).toBe(400);
    expect((await report("outsider", `from=${day(-1)}&to=${day(0)}`)).statusCode).toBe(404);
  });
});
