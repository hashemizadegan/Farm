/** Farm-state snapshots: built from the farm's records, stored content-addressed, re-verified on read. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { verifyFarmSnapshot, type FarmSnapshot } from "@metafarm/domain";
import { contentKey } from "@metafarm/storage";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("farm-state snapshots API", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let storage: Awaited<ReturnType<typeof buildTestApp>>["storage"];
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `ts-owner-${sfx}`, admin: `ts-admin-${sfx}`, manager: `ts-manager-${sfx}`, viewer: `ts-viewer-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let farmId: string;
  let emptyFarmId: string;
  let clock = Date.parse("2026-10-21T08:00:00Z");

  const call = async (who: keyof typeof subjects, method: "GET" | "POST", path: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url: `/v1/tenants/${tenantId}/twin${path}`, headers: { authorization: `Bearer ${await tokenFor(subjects[who])}`, ...headers }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `ts-${sfx}`, name: "Snapshots", ownerUserId: ids.owner! }));
    for (const role of ["admin", "manager", "viewer"] as const) await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [tenantId, ids[role], role]);
    ({ app, storage } = await buildTestApp({ pool, deps: { now: () => new Date((clock += 1000)) } }));
    const owner = { authorization: `Bearer ${await tokenFor(subjects.owner)}` };
    farmId = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: owner, payload: { name: "Grove" } })).json().id;
    emptyFarmId = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: owner, payload: { name: "Empty" } })).json().id;
    for (const body of [
      { farmId, kind: "parcel", name: "Block A", geometry: { type: "Polygon", coordinates: [[[56.0, 30.4], [56.001, 30.4], [56.001, 30.401], [56.0, 30.4]]] }, geomProvenance: "surveyed" },
      { farmId, kind: "building", name: "Packing shed" },
      { farmId, kind: "livestock", name: "Flock 1", externalRef: "LV-7" },
    ])
      expect((await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/rwa/assets`, headers: owner, payload: body })).statusCode).toBe(201);
    const eq = (await pool.query<{ id: string }>(`INSERT INTO equipment (tenant_id, name, kind, farm_id, tracks_hours) VALUES ($1, 'Tractor 2', 'tractor', $2, true) RETURNING id`, [tenantId, farmId])).rows[0]!.id;
    await pool.query(`INSERT INTO meter_readings (tenant_id, equipment_id, hours, read_on) VALUES ($1, $2, 4310.5, '2026-10-01')`, [tenantId, eq]);
    await pool.query(`INSERT INTO crop_seasons (tenant_id, farm_id, crop_name, parcel_label, area_ha, planned_start) VALUES ($1, $2, 'Pistachio', 'A', 1.25, '2026-03-01')`, [tenantId, farmId]);
    const item = (await pool.query<{ id: string }>(`INSERT INTO input_items (tenant_id, name, category, unit) VALUES ($1, 'Urea 46%', 'fertilizer', 'kg') RETURNING id`, [tenantId])).rows[0]!.id;
    await pool.query(`INSERT INTO stock_movements (tenant_id, item_id, kind, quantity, occurred_on, farm_id) VALUES ($1, $2, 'receive', 800, '2026-09-01', $3), ($1, $2, 'use', -120.5, '2026-09-15', $3)`, [tenantId, item, farmId]);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  let first: { id: string; snapshotId: string; root: string; contentSha256: string; entityCount: number };

  it("records a snapshot of the farm's records, stored content-addressed (operators only)", async () => {
    expect((await call("manager", "POST", `/farms/${farmId}/snapshots`)).statusCode).toBe(403);
    const r = await call("admin", "POST", `/farms/${farmId}/snapshots`);
    expect(r.statusCode).toBe(201);
    first = r.json();
    expect(first).toMatchObject({ subjectType: "farm", subjectId: farmId, schema: "metafarm.farm-snapshot", entityCount: 6, storageRef: `sha256:${first.contentSha256}` });
    expect(first.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(await storage.head(contentKey(tenantId, first.contentSha256))).toBeDefined();
  });

  it("returns the stored snapshot verified, with only plain, non-personal data", async () => {
    expect((await call("viewer", "GET", `/snapshots/${first.id}`)).statusCode).toBe(403);
    const r = await call("manager", "GET", `/snapshots/${first.id}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers.etag).toBe(`"${first.snapshotId}"`);
    const body = r.json() as { check: { ok: boolean }; snapshot: FarmSnapshot };
    expect(body.check).toEqual({ ok: true, problems: [] });
    expect((await verifyFarmSnapshot(body.snapshot)).ok).toBe(true);
    expect(body.snapshot.entities.map((e) => e.type).sort()).toEqual(["animal", "crop", "inventory", "machine", "plot", "structure"]);
    const machine = body.snapshot.entities.find((e) => e.type === "machine")!;
    expect(machine.data).toMatchObject({ source: "equipment", name: "Tractor 2", hourMeter: "4310.5" });
    expect(body.snapshot.entities.find((e) => e.type === "inventory")!.data).toMatchObject({ netQuantityOnFarm: "679.500" });
    expect(body.snapshot.entities.find((e) => e.type === "crop")!.data).toMatchObject({ areaHa: "1.2500", plannedStart: "2026-03-01" });
    expect(JSON.stringify(body.snapshot)).not.toMatch(/created_by|recorded_by|createdBy|email/);
  });

  it("keeps the same root for the same state and changes it when the state changes", async () => {
    const again = (await call("admin", "POST", `/farms/${farmId}/snapshots`)).json();
    expect(again.root).toBe(first.root);
    expect(again.snapshotId).not.toBe(first.snapshotId);
    await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/rwa/assets`, headers: { authorization: `Bearer ${await tokenFor(subjects.owner)}` }, payload: { farmId, kind: "storage_unit", name: "Cold store 1" } });
    const changed = (await call("admin", "POST", `/farms/${farmId}/snapshots`)).json();
    expect(changed.entityCount).toBe(7);
    expect(changed.root).not.toBe(first.root);
  });

  it("lists snapshots newest first with a cursor, so a client can sync", async () => {
    const page = (await call("manager", "GET", `/farms/${farmId}/snapshots?limit=1`)).json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0].schema).toBe("metafarm.farm-snapshot");
    const all = (await call("manager", "GET", `/farms/${farmId}/snapshots`)).json();
    expect(all.items).toHaveLength(3);
    expect(all.items.at(-1).id).toBe(first.id);
  });

  it("replays a resend with the same Idempotency-Key", async () => {
    const key = crypto.randomUUID();
    const a = await call("admin", "POST", `/farms/${farmId}/snapshots`, undefined, { "idempotency-key": key });
    const b = await call("admin", "POST", `/farms/${farmId}/snapshots`, undefined, { "idempotency-key": key });
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.json()).toMatchObject({ id: a.json().id, snapshotId: a.json().snapshotId });
    expect((await call("admin", "POST", `/farms/${emptyFarmId}/snapshots`, undefined, { "idempotency-key": key })).json().error).toBe("idempotency_key_reused");
  });

  it("refuses an empty farm, a body, and snapshot commitments made by hand", async () => {
    expect((await call("admin", "POST", `/farms/${emptyFarmId}/snapshots`)).json().error).toBe("nothing_to_snapshot");
    expect((await call("admin", "POST", `/farms/${farmId}/snapshots`, { entities: [] })).statusCode).toBe(400);
    const forged = await call("admin", "POST", "/data-commitments", {
      subjectType: "farm",
      subjectId: farmId,
      schema: "metafarm.farm-snapshot",
      schemaVersion: 1,
      contentSha256: "a".repeat(64),
      sourceTime: "2026-10-21T08:00:00Z",
    });
    expect(forged.json().error).toBe("reserved_schema");
  });

  it("plans a data-only anchor for a snapshot root and for a batch root; nothing is executable", async () => {
    expect((await call("viewer", "GET", `/snapshots/${first.id}/anchor-plan?carrier=token2022_metadata`)).statusCode).toBe(403);
    const r = await call("manager", "GET", `/snapshots/${first.id}/anchor-plan?carrier=token2022_metadata`);
    expect(r.statusCode).toBe(200);
    const label = `farm-${farmId.replace(/-/g, "").slice(0, 14)}`;
    expect(r.json()).toEqual({
      commitmentId: first.id,
      snapshotId: first.snapshotId,
      plan: {
        scheme: "metafarm-anchor/1",
        carrier: "token2022_metadata",
        network: "solana-devnet",
        subject: "snapshot",
        root: first.root,
        metadataField: { key: `mf:snapshot:${label}`, value: `metafarm-farm-snapshot/1:${first.root}` },
        executable: false,
        reason: "anchoring_not_enabled",
      },
    });
    expect((await call("manager", "GET", `/snapshots/${first.id}/anchor-plan?carrier=token2022_metadata&network=solana-mainnet`)).json().error).toBe("anchor_plan_refused");
    expect((await call("manager", "GET", `/snapshots/${first.id}/anchor-plan?carrier=bubblegum_v1_leaf`)).json().error).toBe("not_configured");
    expect((await call("manager", "GET", `/snapshots/${first.id}/anchor-plan?carrier=evm`)).statusCode).toBe(400);
    expect((await call("manager", "GET", `/snapshots/${crypto.randomUUID()}/anchor-plan?carrier=token2022_metadata`)).statusCode).toBe(404);

    const c = (await call("admin", "POST", "/data-commitments", { subjectType: "farm", subjectId: farmId, schema: "metafarm.survey", schemaVersion: 1, contentSha256: "c".repeat(64), sourceTime: "2026-10-21T08:00:00Z" })).json();
    const batch = (await call("admin", "POST", "/data-commitments/batches", { dataset: "survey/26", commitmentIds: [c.id] })).json();
    const b = await call("manager", "GET", `/data-commitments/batches/${batch.id}/anchor-plan?carrier=token2022_metadata`);
    expect(b.statusCode).toBe(200);
    expect(b.json().plan).toMatchObject({ subject: "batch", root: batch.merkleRoot, metadataField: { key: "mf:batch:survey/26", value: `metafarm-merkle-sha256/1:${batch.merkleRoot}` }, executable: false });
    const long = (await call("admin", "POST", "/data-commitments/batches", { dataset: "a-dataset-name-that-is-long", commitmentIds: [(await call("admin", "POST", "/data-commitments", { subjectType: "farm", subjectId: farmId, schema: "metafarm.survey", schemaVersion: 1, contentSha256: "d".repeat(64), sourceTime: "2026-10-21T08:00:00Z" })).json().id] })).json();
    expect((await call("manager", "GET", `/data-commitments/batches/${long.id}/anchor-plan?carrier=token2022_metadata`)).json().error).toBe("anchor_plan_refused");
  });

  it("plans a Bubblegum anchor only with a configured https document base", async () => {
    const { app: configured } = await buildTestApp({ pool, env: { RWA_CNFT_METADATA_BASE_URL: "https://metadata.example.test" }, deps: { storage } });
    try {
      const r = await configured.inject({ method: "GET", url: `/v1/tenants/${tenantId}/twin/snapshots/${first.id}/anchor-plan?carrier=bubblegum_v1_leaf`, headers: { authorization: `Bearer ${await tokenFor(subjects.manager)}` } });
      expect(r.statusCode).toBe(200);
      expect(r.json().plan).toMatchObject({ carrier: "bubblegum_v1_leaf", leafMetadata: { symbol: "MFANCHOR", uri: `https://metadata.example.test/v1/public/anchors/${first.root}` }, executable: false });
    } finally {
      await configured.close();
    }
  });

  it("notices stored bytes that changed or went missing", async () => {
    const key = contentKey(tenantId, first.contentSha256);
    await storage.putObject(key, Buffer.from("{}"), "application/json");
    expect((await call("manager", "GET", `/snapshots/${first.id}`)).json().error).toBe("content_integrity_failed");
    await storage.delete(key);
    expect((await call("manager", "GET", `/snapshots/${first.id}`)).json().error).toBe("snapshot_content_missing");
  });

  it("serves only snapshot commitments of this workspace", async () => {
    const other = (await call("admin", "POST", "/data-commitments", { subjectType: "farm", subjectId: farmId, schema: "metafarm.survey", schemaVersion: 1, contentSha256: "b".repeat(64), sourceTime: "2026-10-21T08:00:00Z" })).json();
    expect((await call("manager", "GET", `/snapshots/${other.id}`)).statusCode).toBe(404);
    expect((await call("manager", "GET", `/snapshots/${crypto.randomUUID()}`)).statusCode).toBe(404);
  });
});
