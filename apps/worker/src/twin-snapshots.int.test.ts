/** Scheduled farm-state snapshots: fan-out, record on change only, system-attributed and audited. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFarm, createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, withTenant, type Pool } from "@metafarm/db";
import { QUEUES, SNAPSHOT_COMMITMENT_SCHEMA, reconstructFarmSnapshot, type JobPayloads } from "@metafarm/domain";
import { createObjectContentStore, createMemoryStorage } from "@metafarm/storage";
import { createLogger } from "@metafarm/observability";
import { twinSnapshotHandler, twinSnapshotSweepHandler, type TwinSnapshotOutcome } from "./handlers/twin-snapshots";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const log = createLogger({ service: "test", level: "silent" });
const ctx = { log, attempt: 1, jobId: "t" };

d("twin snapshot jobs", () => {
  let pool: Pool;
  let tenantId: string;
  let farmId: string;
  let emptyFarmId: string;
  const storage = createMemoryStorage();
  let clock = Date.parse("2026-10-21T02:00:00Z");
  const now = () => new Date((clock += 60_000));
  const run = (farm: string) => twinSnapshotHandler(pool, (t) => createObjectContentStore(storage, t), now)({ tenantId, farmId: farm, bucket: "b" }, ctx) as Promise<TwinSnapshotOutcome>;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
    const sfx = Math.random().toString(36).slice(2, 8);
    const userId = (await upsertUserBySubject(pool, { issuer: "test", subject: `tws-${sfx}` })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `tws-${sfx}`, name: "TW", ownerUserId: userId }));
    farmId = (await withTenant(pool, tenantId, (tx) => createFarm(tx, { name: "F", timezone: "UTC", createdBy: userId }))).id;
    emptyFarmId = (await withTenant(pool, tenantId, (tx) => createFarm(tx, { name: "Empty", timezone: "UTC", createdBy: userId }))).id;
    await pool.query(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'building', 'Shed')`, [tenantId, farmId]);
    await pool.query(`INSERT INTO crop_seasons (tenant_id, farm_id, crop_name, planned_start) VALUES ($1, $2, 'Wheat', '2026-01-10')`, [tenantId, farmId]);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("fans out one job per farm that has something to snapshot", async () => {
    const queued: JobPayloads[typeof QUEUES.twinSnapshots][] = [];
    const enqueue = async (q: string, p: unknown) => void (q === QUEUES.twinSnapshots && queued.push(p as JobPayloads[typeof QUEUES.twinSnapshots]));
    await twinSnapshotSweepHandler(pool, enqueue as never)({ bucket: "2026-10-21T02:00:00.000Z" }, ctx);
    const mine = queued.filter((j) => j.tenantId === tenantId);
    expect(mine).toEqual([{ tenantId, farmId, bucket: "2026-10-21T02:00:00.000Z" }]);
  });

  it("records a snapshot attributed to the system, stored content-addressed and audited", async () => {
    const r = await run(farmId);
    expect(r.status).toBe("recorded");
    if (r.status !== "recorded") return;
    expect(r.entityCount).toBe(2);
    const row = (await pool.query(`SELECT recorded_by, data_schema, content_sha256 FROM data_commitments WHERE id = $1`, [r.commitmentId])).rows[0];
    expect(row).toMatchObject({ recorded_by: null, data_schema: SNAPSHOT_COMMITMENT_SCHEMA });
    const bytes = await createObjectContentStore(storage, tenantId).get(row.content_sha256);
    const { check, snapshot } = await reconstructFarmSnapshot(new TextDecoder().decode(bytes!));
    expect([check.ok, snapshot.root]).toEqual([true, r.root]);
    const audit = (await pool.query(`SELECT actor_type, action FROM audit_events WHERE tenant_id = $1 AND target_id = $2`, [tenantId, r.commitmentId])).rows;
    expect(audit).toEqual([{ actor_type: "job", action: "twin.snapshot.recorded" }]);
  });

  it("records nothing while the state is unchanged, and again once it changes", async () => {
    const same = await run(farmId);
    expect(same.status).toBe("unchanged");
    await pool.query(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'storage_unit', 'Silo')`, [tenantId, farmId]);
    const changed = await run(farmId);
    expect(changed).toMatchObject({ status: "recorded", entityCount: 3 });
    const count = (await pool.query(`SELECT count(*)::int AS n FROM data_commitments WHERE tenant_id = $1 AND subject_id = $2`, [tenantId, farmId])).rows[0].n;
    expect(count).toBe(2);
  });

  it("treats a damaged previous snapshot as changed", async () => {
    const latest = (await pool.query(`SELECT content_sha256 FROM data_commitments WHERE tenant_id = $1 AND subject_id = $2 ORDER BY created_at DESC LIMIT 1`, [tenantId, farmId])).rows[0];
    await storage.putObject(`tenants/${tenantId}/content/${latest.content_sha256}`, Buffer.from("{}"), "application/json");
    expect((await run(farmId)).status).toBe("recorded");
  });

  it("skips farms with nothing to snapshot", async () => {
    expect(await run(emptyFarmId)).toEqual({ status: "skipped", reason: "nothing_to_snapshot" });
  });
});
