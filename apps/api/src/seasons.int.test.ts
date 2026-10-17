/** Crop seasons against a real database: stages, automatic harvest attachment, the season summary and closing. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("crop seasons", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `s-owner-${sfx}`, worker: `s-worker-${sfx}`, viewer: `s-viewer-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let farmId: string;
  let seasonId: string;
  const auth = async (who: keyof typeof subjects) => ({ authorization: `Bearer ${await tokenFor(subjects[who])}` });
  const base = () => `/v1/tenants/${tenantId}/farms/${farmId}`;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `season-${sfx}`, name: "Seasons", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'worker'), ($1, $3, 'viewer')`, [tenantId, ids.worker, ids.viewer]);
    ({ app } = await buildTestApp({ pool, deps: { now: () => new Date("2026-10-18T09:00:00Z") } }));
    farmId = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: await auth("owner"), payload: { name: "Season farm" } })).json().id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("lets managers start a season, not workers", async () => {
    const payload = { cropName: "Wheat", variety: "Pishtaz", parcelLabel: "Block 1", areaHa: "2.5", plannedStart: "2026-10-01" };
    expect((await app.inject({ method: "POST", url: `${base()}/seasons`, headers: await auth("worker"), payload })).statusCode).toBe(403);
    const r = await app.inject({ method: "POST", url: `${base()}/seasons`, headers: await auth("owner"), payload });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: "active", areaHa: "2.5", currentStage: null });
    seasonId = r.json().id;
  });

  it("lets workers record growth stages, not viewers", async () => {
    const url = `${base()}/seasons/${seasonId}/stages`;
    expect((await app.inject({ method: "POST", url, headers: await auth("viewer"), payload: { stage: "sowing", observedOn: "2026-10-02" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: await auth("worker"), payload: { stage: "sowing", observedOn: "2026-09-01" } })).statusCode).toBe(400);
    await app.inject({ method: "POST", url, headers: await auth("worker"), payload: { stage: "sowing", observedOn: "2026-10-02" } });
    const r = await app.inject({ method: "POST", url, headers: await auth("worker"), payload: { stage: "emergence", observedOn: "2026-10-12", note: "even stand" } });
    expect(r.json()).toMatchObject({ currentStage: "emergence", currentStageOn: "2026-10-12" });
  });

  it("attaches harvests on the parcel automatically and summarises the season", async () => {
    const h = await app.inject({ method: "POST", url: `${base()}/harvests`, headers: await auth("worker"), payload: { cropName: "wheat", parcelLabel: "block 1", harvestedOn: "2026-10-17", quantity: "1250.5", unit: "kg" } });
    expect(h.json().seasonId).toBe(seasonId);
    await app.inject({ method: "POST", url: `${base()}/harvests`, headers: await auth("worker"), payload: { cropName: "Wheat", parcelLabel: "Block 1", harvestedOn: "2026-10-18", quantity: "0.5", unit: "t" } });
    // A harvest elsewhere on the farm is not this season's.
    const other = await app.inject({ method: "POST", url: `${base()}/harvests`, headers: await auth("worker"), payload: { cropName: "Wheat", parcelLabel: "Block 2", harvestedOn: "2026-10-18", quantity: "9", unit: "kg" } });
    expect(other.json().seasonId).toBeNull();

    const item = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/inventory/items`, headers: await auth("owner"), payload: { name: "Urea", category: "fertilizer", unit: "kg" } })).json();
    await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/inventory/movements`, headers: await auth("worker"), payload: { kind: "use", itemId: item.id, quantity: "50", occurredOn: "2026-10-05", farmId, parcelLabel: "Block 1" } });
    await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/inventory/movements`, headers: await auth("worker"), payload: { kind: "use", itemId: item.id, quantity: "25", occurredOn: "2026-10-06", farmId, parcelLabel: "Block 2" } });

    const detail = (await app.inject({ method: "GET", url: `${base()}/seasons/${seasonId}`, headers: await auth("viewer") })).json();
    expect(detail.stages.map((s: { stage: string }) => s.stage)).toEqual(["sowing", "emergence"]);
    expect(detail.harvest.totals).toEqual([
      { unit: "kg", quantity: "1250.5", perHa: "500.2" },
      { unit: "t", quantity: "0.5", perHa: "0.2" },
    ]);
    expect(detail.inputs).toEqual([{ itemId: item.id, itemName: "Urea", unit: "kg", quantity: "50", applications: 1 }]);
  });

  it("closes only with an end day, and refuses new stages once closed", async () => {
    const url = `${base()}/seasons/${seasonId}`;
    expect((await app.inject({ method: "PATCH", url, headers: await auth("owner"), payload: { status: "closed" } })).statusCode).toBe(400);
    const closed = await app.inject({ method: "PATCH", url, headers: await auth("owner"), payload: { status: "closed", endedOn: "2026-10-18" } });
    expect(closed.json()).toMatchObject({ status: "closed", endedOn: "2026-10-18" });
    expect((await app.inject({ method: "POST", url: `${url}/stages`, headers: await auth("worker"), payload: { stage: "post-harvest", observedOn: "2026-10-18" } })).statusCode).toBe(409);
    const reopened = await app.inject({ method: "PATCH", url, headers: await auth("owner"), payload: { status: "active" } });
    expect(reopened.json()).toMatchObject({ status: "active", endedOn: null });
  });
});
