/**
 * Integration tests: tenant isolation at the database layer.
 * Requires DATABASE_URL pointing at a disposable PostgreSQL + PostGIS database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "./pool";
import { migrateUp } from "./migrate";
import { withSystem, withTenant } from "./tenant";
import { createTenantWithOwner, upsertUserBySubject } from "./repositories/identity";
import { createFarm, getFarm, insertBoundaryVersion, listFarms } from "./repositories/farms";
import { writeAudit } from "./repositories/ops";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("tenant isolation (PostgreSQL RLS)", () => {
  let pool: Pool;
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let farmA: string;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
    const suffix = Math.random().toString(36).slice(2, 8);
    const ua = await upsertUserBySubject(pool, { issuer: "test", subject: `a-${suffix}` });
    const ub = await upsertUserBySubject(pool, { issuer: "test", subject: `b-${suffix}` });
    userA = ua.id;
    tenantA = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `ta-${suffix}`, name: "A", ownerUserId: ua.id }));
    tenantB = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `tb-${suffix}`, name: "B", ownerUserId: ub.id }));
    farmA = (await withTenant(pool, tenantA, (tx) => createFarm(tx, { name: "Farm A", timezone: "UTC", createdBy: userA }))).id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("does not return another tenant's farm by id", async () => {
    const seen = await withTenant(pool, tenantB, (tx) => getFarm(tx, farmA));
    expect(seen).toBeUndefined();
  });

  it("does not list another tenant's farms", async () => {
    const farms = await withTenant(pool, tenantB, (tx) => listFarms(tx, 100));
    expect(farms.map((f) => f.id)).not.toContain(farmA);
  });

  it("RLS blocks a raw query that forgets the tenant filter", async () => {
    const rows = await withTenant(pool, tenantB, async (tx) => (await tx.query("SELECT id FROM farms")).rows);
    expect(rows.map((r: { id: string }) => r.id)).not.toContain(farmA);
  });

  it("RLS blocks writing a row into another tenant", async () => {
    await expect(
      withTenant(pool, tenantB, (tx) =>
        tx.query(`INSERT INTO farms (tenant_id, name) VALUES ($1, 'sneaky')`, [tenantA]),
      ),
    ).rejects.toThrow();
  });

  it("stores boundaries as MultiPolygon in SRID 4326", async () => {
    const b = await withTenant(pool, tenantA, (tx) =>
      insertBoundaryVersion(tx, {
        farmId: farmA,
        geometry: {
          type: "Polygon",
          coordinates: [[[10, 0], [10.001, 0], [10.001, 0.001], [10, 0.001], [10, 0]]],
        },
        source: "drawn",
        geometryHash: `h-${Math.random()}`,
        areaM2: 12_000,
        vertexCount: 5,
        submittedBy: userA,
      }),
    );
    expect(b.geojson.type).toBe("MultiPolygon");
    expect(b.provenance_label).toBe("user-entered");
    expect(b.version).toBe(1);
  });

  it("refuses independently-verified without evidence", async () => {
    await expect(
      withTenant(pool, tenantA, (tx) =>
        tx.query(`UPDATE boundary_versions SET provenance_label = 'independently-verified' WHERE tenant_id = $1`, [tenantA]),
      ),
    ).rejects.toThrow(/without evidence/);
  });

  it("keeps audit events append-only", async () => {
    await withTenant(pool, tenantA, (tx) => writeAudit(tx, { actorType: "system", action: "test.event" }));
    await expect(
      withSystem(pool, (tx) => tx.query(`UPDATE audit_events SET action = 'tampered' WHERE action = 'test.event'`)),
    ).rejects.toThrow(/append-only/);
    await expect(withSystem(pool, (tx) => tx.query(`DELETE FROM audit_events WHERE action = 'test.event'`))).rejects.toThrow(
      /append-only/,
    );
  });
});
