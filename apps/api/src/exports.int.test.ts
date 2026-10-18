/** CSV exports against a real database: content, filters, headings, formula safety and access. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const parseCsv = (body: string) => {
  expect(body.startsWith("\uFEFF")).toBe(true);
  return body.slice(1).trimEnd().split("\r\n");
};

d("exports", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `x-owner-${sfx}`, viewer: `x-viewer-${sfx}`, outsider: `x-out-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let farmId: string;
  let otherFarmId: string;
  const auth = async (who: keyof typeof subjects) => ({ authorization: `Bearer ${await tokenFor(subjects[who])}` });
  const get = async (who: keyof typeof subjects, path: string) => app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/exports/${path}`, headers: await auth(who) });

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `exp-${sfx}`, name: "Exp", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'viewer')`, [tenantId, ids.viewer]);
    await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `exp-o-${sfx}`, name: "Other", ownerUserId: ids.outsider! }));
    ({ app } = await buildTestApp({ pool }));
    const h = await auth("owner");
    const farm = async (name: string) => (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: h, payload: { name } })).json().id as string;
    farmId = await farm("Export farm");
    otherFarmId = await farm("Second farm");
    const item = (
      await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/inventory/items`,
        headers: h,
        payload: { name: "=cmd|'/C calc'!A0", category: "crop-protection", unit: "l", reorderLevel: "1", preHarvestIntervalDays: 7 },
      })
    ).json();
    const move = (payload: object) => app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/inventory/movements`, headers: h, payload: { itemId: item.id, ...payload } });
    await move({ kind: "receive", quantity: "10", occurredOn: "2026-09-01" });
    await move({ kind: "use", quantity: "2.5", occurredOn: "2026-09-10", farmId, parcelLabel: "Block 1", note: 'windy, "light"' });
    await move({ kind: "use", quantity: "1", occurredOn: "2026-10-05", farmId: otherFarmId });
    await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/farms/${farmId}/harvests`,
      headers: h,
      payload: { cropName: "Pistachio", harvestedOn: "2026-10-01", quantity: "120", unit: "kg" },
    });
    await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms/${farmId}/tasks`, headers: h, payload: { title: "Scout pests", kind: "scouting", dueDate: "2026-10-20" } });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("exports the input log, oldest first, with uses only and safe cells", async () => {
    const r = await get("viewer", "input-log");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="input-log_start_\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = parseCsv(r.body);
    expect(lines[0]).toBe("Date,Farm,Parcel,Product,Category,Quantity,Unit,Lot,Pre-harvest interval (days),Task,Recorded by,Note");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^2026-09-10,Export farm,Block 1,'=cmd\|'\/C calc'!A0,crop-protection,2\.5,l,,7,,[^,]*,"windy, ""light"""$/);
    expect(lines[2]).toMatch(/^2026-10-05,Second farm,/);
  });

  it("filters by farm and dates and writes Persian headings", async () => {
    const lines = parseCsv((await get("owner", `input-log?farmId=${otherFarmId}&from=2026-10-01&to=2026-10-31&lang=fa`)).body);
    expect(lines[0]!.startsWith("تاریخ,مزرعه")).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.startsWith("2026-10-05,Second farm")).toBe(true);
    expect((await get("owner", "input-log?from=2026-10-02&to=2026-10-01")).statusCode).toBe(400);
  });

  it("exports harvests, tasks and stock", async () => {
    const harvest = parseCsv((await get("owner", "harvests")).body);
    expect(harvest).toHaveLength(2);
    expect(harvest[1]).toMatch(/^[2-9A-HJKMNP-Z]{10},2026-10-01,Export farm,Pistachio,,120,kg,,[^,]*,[0-9a-f]{64},\w+,,no,$/);

    const tasks = parseCsv((await get("owner", `tasks?farmId=${farmId}`)).body);
    expect(tasks[1]).toMatch(/^2026-10-20,Export farm,Scout pests,scouting,,normal,todo,/);

    const stock = parseCsv((await get("owner", "stock?lang=fa")).body);
    expect(stock[1]).toBe("'=cmd|'/C calc'!A0,crop-protection,l,6.5,1,خیر,7,,2026-10-05,خیر");
    expect((await get("owner", `stock?farmId=${farmId}`)).statusCode).toBe(400);
  });

  it("is only for members, and audited", async () => {
    expect((await get("outsider", "stock")).statusCode).toBe(404);
    expect((await get("owner", "secrets")).statusCode).toBe(400);
    const a = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'export.downloaded'`, [tenantId]);
    expect(a.rows[0].n).toBeGreaterThan(0);
  });
});
