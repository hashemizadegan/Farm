/** Weekly summary sweep against a real database, at a fixed clock. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFarm, createPool, createTenantWithOwner, mergeTenantSettings, migrateUp, upsertUserBySubject, withSystem, withTenant, type Pool } from "@metafarm/db";
import { createLogger } from "@metafarm/observability";
import { weeklyReportSweepHandler } from "./handlers/reports";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const log = createLogger({ service: "test", level: "silent" });
const ctx = { log, attempt: 1, jobId: "t" };
const job = { bucket: "b" };
// Saturday 2026-10-17, 07:30 in Tehran: the first morning of a Saturday week.
const saturdayMorning = () => new Date("2026-10-17T04:00:00Z");

d("weekly summary", () => {
  let pool: Pool;
  let tenantId: string;
  let quietTenantId: string;
  const ids: Record<string, string> = {};

  const inbox = async (userId: string, tenant = tenantId) =>
    (await pool.query(`SELECT kind, data, dedupe_key FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND kind = 'weekly_report'`, [tenant, userId])).rows;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
    const sfx = Math.random().toString(36).slice(2, 8);
    for (const k of ["owner", "manager", "worker", "quiet"]) ids[k] = (await upsertUserBySubject(pool, { issuer: "test", subject: `wk-${k}-${sfx}` })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `wk-${sfx}`, name: "Weekly", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'worker')`, [tenantId, ids.manager, ids.worker]);
    const farm = await withTenant(pool, tenantId, (tx) => createFarm(tx, { name: "Pistachio grove", timezone: "Asia/Tehran", createdBy: ids.owner! }));
    // Last week (Sat 10 – Fri 16 Oct): two tasks done, one still open.
    await pool.query(
      `INSERT INTO farm_tasks (tenant_id, farm_id, title, kind, due_date, status, completed_at, completed_by)
       VALUES ($1, $2, 'Irrigate', 'irrigation', '2026-10-12', 'done', '2026-10-12T06:00:00Z', $3),
              ($1, $2, 'Prune', 'pruning', '2026-10-14', 'done', '2026-10-14T06:00:00Z', $3),
              ($1, $2, 'Scout', 'scouting', '2026-10-15', 'todo', NULL, NULL)`,
      [tenantId, farm.id, ids.worker],
    );
    // A workspace with a farm but nothing recorded.
    quietTenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `wk-q-${sfx}`, name: "Quiet", ownerUserId: ids.quiet! }));
    await withTenant(pool, quietTenantId, (tx) => createFarm(tx, { name: "Empty", timezone: "Asia/Tehran", createdBy: ids.quiet! }));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("is not sent before 07:00 or on other days", async () => {
    await weeklyReportSweepHandler(pool, () => new Date("2026-10-17T03:00:00Z"))(job, ctx);
    await weeklyReportSweepHandler(pool, () => new Date("2026-10-18T06:00:00Z"))(job, ctx);
    expect(await inbox(ids.owner!)).toEqual([]);
  });

  it("tells owners and managers about last week, once", async () => {
    await weeklyReportSweepHandler(pool, saturdayMorning)(job, ctx);
    await weeklyReportSweepHandler(pool, () => new Date("2026-10-17T09:00:00Z"))(job, ctx);
    for (const who of ["owner", "manager"]) {
      const n = await inbox(ids[who]!);
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({
        dedupe_key: "weekly:2026-10-10",
        data: { from: "2026-10-10", to: "2026-10-16", tasksDone: 2, dueStillOpen: 1, applications: 0, harvestBatches: 0, alerts: 0 },
      });
    }
    // Field workers do not get the management summary.
    expect(await inbox(ids.worker!)).toEqual([]);
  });

  it("stays quiet for workspaces with nothing recorded, and when switched off", async () => {
    expect(await inbox(ids.quiet!, quietTenantId)).toEqual([]);
    await withSystem(pool, (tx) => mergeTenantSettings(tx, tenantId, { weeklyReport: { enabled: false, weekStartsOn: 6 } }));
    // The following Saturday.
    await weeklyReportSweepHandler(pool, () => new Date("2026-10-24T04:00:00Z"))(job, ctx);
    expect(await inbox(ids.owner!)).toHaveLength(1);
  });
});
