/**
 * API authorization and workflow integration tests against a real
 * PostgreSQL + PostGIS database (DATABASE_URL). Queue and storage are in-memory.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, migrateUp, upsertUserBySubject, withSystem, createTenantWithOwner, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const square = (dx = 0) => ({
  type: "Polygon",
  coordinates: [[[10 + dx, 0], [10.0009 + dx, 0], [10.0009 + dx, 0.0009], [10 + dx, 0.0009], [10 + dx, 0]]],
});

d("API authorization", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let jobs: Awaited<ReturnType<typeof buildTestApp>>["jobs"];
  let storage: Awaited<ReturnType<typeof buildTestApp>>["storage"];
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `owner-${sfx}`, viewer: `viewer-${sfx}`, outsider: `outsider-${sfx}`, verifier: `verifier-${sfx}` };
  let tenantId: string;
  let otherTenantId: string;
  let farmId: string;
  const auth = async (who: keyof typeof subjects) => ({ authorization: `Bearer ${await tokenFor(subjects[who])}` });

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    const owner = await upsertUserBySubject(pool, { issuer: "dev", subject: subjects.owner });
    const viewer = await upsertUserBySubject(pool, { issuer: "dev", subject: subjects.viewer });
    const verifier = await upsertUserBySubject(pool, { issuer: "dev", subject: subjects.verifier });
    const outsider = await upsertUserBySubject(pool, { issuer: "dev", subject: subjects.outsider });
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `t-${sfx}`, name: "T", ownerUserId: owner.id }));
    otherTenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `o-${sfx}`, name: "O", ownerUserId: outsider.id }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'viewer'), ($1, $3, 'verifier')`, [
      tenantId,
      viewer.id,
      verifier.id,
    ]);
    ({ app, jobs, storage } = await buildTestApp({ pool }));
    const r = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: await auth("owner"), payload: { name: "Test farm", origin: { lon: 10, lat: 0 } } });
    expect(r.statusCode).toBe(201);
    farmId = r.json().id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("returns 404 (not 403) for a tenant the caller does not belong to", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/farms`, headers: await auth("outsider") });
    expect(r.statusCode).toBe(404);
  });

  it("does not expose a farm through another tenant's path", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/tenants/${otherTenantId}/farms/${farmId}`, headers: await auth("outsider") });
    expect(r.statusCode).toBe(404);
  });

  it("lets viewers read but not write", async () => {
    const read = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/farms/${farmId}`, headers: await auth("viewer") });
    expect(read.statusCode).toBe(200);
    const write = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: await auth("viewer"), payload: { name: "nope" } });
    expect(write.statusCode).toBe(403);
  });

  it("rejects invalid geometry with structured issues", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/farms/${farmId}/boundaries`,
      headers: await auth("owner"),
      payload: { source: "drawn", geojson: { type: "Polygon", coordinates: [[[0, 0], [0.001, 0.001], [0.001, 0], [0, 0.001], [0, 0]]] } },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().details.map((i: { code: string }) => i.code)).toContain("SELF_INTERSECTION");
  });

  it("accepts a valid boundary as user-entered, queues GIS validation, and rejects the duplicate", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/farms/${farmId}/boundaries`,
      headers: await auth("owner"),
      payload: { source: "coordinates", geojson: square() },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().provenance).toBe("user-entered");
    expect(first.json().validationStatus).toBe("pending");
    expect(jobs.jobs.some((j) => j.queue === "gis-validation")).toBe(true);

    const dup = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/farms/${farmId}/boundaries`,
      headers: await auth("owner"),
      payload: { source: "drawn", geojson: { ...square(), coordinates: [[...square().coordinates[0]!].reverse()] } },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("only lets verifiers attach evidence", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/farms/${farmId}/boundaries/00000000-0000-0000-0000-000000000000/evidence`,
      headers: await auth("owner"),
      payload: { kind: "other", mediaObjectId: "00000000-0000-0000-0000-000000000000" },
    });
    // Owners hold every permission, so this reaches the lookup and 404s; viewers are refused outright.
    expect(r.statusCode).toBe(404);
    const v = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/farms/${farmId}/boundaries/00000000-0000-0000-0000-000000000000/evidence`,
      headers: await auth("viewer"),
      payload: { kind: "other", mediaObjectId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(v.statusCode).toBe(403);
  });

  it("labels scenarios as simulated", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/farms/${farmId}/scenarios`,
      headers: await auth("owner"),
      payload: {
        cropName: "Example",
        plantedAreaHa: 1,
        yieldPerHa: { low: 1, base: 2, high: 3 },
        yieldUnit: "t",
        pricePerUnit: { low: 1, base: 1, high: 1 },
        costs: { low: 0, base: 0, high: 0 },
        currency: "EUR",
      },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().kind).toBe("simulated");
    expect(r.json().result.disclaimer).toMatch(/not realised income/);
  });

  it("issues signed upload tickets and rejects mismatched uploads", async () => {
    const t = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/uploads`,
      headers: await auth("owner"),
      payload: { filename: "../../etc/passwd.png", contentType: "image/png", byteSize: 1000, purpose: "observation-photo", sha256: "a".repeat(64) },
    });
    expect(t.statusCode).toBe(201);
    const ticket = t.json();
    expect(ticket.uploadUrl).not.toContain("passwd");

    const wrongType = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/uploads`,
      headers: await auth("owner"),
      payload: { filename: "x.html", contentType: "application/pdf", byteSize: 10, purpose: "observation-photo", sha256: "a".repeat(64) },
    });
    expect(wrongType.statusCode).toBe(400);

    const missing = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/uploads/${ticket.mediaId}/complete`, headers: await auth("owner") });
    expect(missing.statusCode).toBe(422);

    // A second ticket, "uploaded" with the declared size, completes.
    const t2 = (
      await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/uploads`,
        headers: await auth("owner"),
        payload: { filename: "ok.png", contentType: "image/png", byteSize: 42, purpose: "observation-photo", sha256: "b".repeat(64) },
      })
    ).json();
    const key = (await pool.query(`SELECT storage_key FROM media_objects WHERE id = $1`, [t2.mediaId])).rows[0].storage_key;
    storage.put(key, { byteSize: 42, contentType: "image/png" });
    const done = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/uploads/${t2.mediaId}/complete`, headers: await auth("owner") });
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe("uploaded");
  });

  it("restricts audit events to admins and owners", async () => {
    const viewer = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/audit-events`, headers: await auth("viewer") });
    expect(viewer.statusCode).toBe(403);
    const owner = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/audit-events`, headers: await auth("owner") });
    expect(owner.statusCode).toBe(200);
    const actions = owner.json().items.map((e: { action: string }) => e.action);
    expect(actions).toContain("farm.created");
    expect(actions).toContain("permission.denied");
  });

  it("rejects a replayed wallet nonce", async () => {
    const address = "0x1111111111111111111111111111111111111111";
    const { app: walletApp } = await buildTestApp({ pool, deps: { recoverMessageAddress: async () => address } });
    try {
      const n = await walletApp.inject({ method: "POST", url: "/v1/wallet/nonce", headers: await auth("owner"), payload: { address, chainId: 31337 } });
      expect(n.statusCode).toBe(200);
      const signature = `0x${"11".repeat(65)}`;
      const first = await walletApp.inject({ method: "POST", url: "/v1/wallet/verify", headers: await auth("owner"), payload: { message: n.json().message, signature } });
      expect(first.statusCode).toBe(200);
      const replay = await walletApp.inject({ method: "POST", url: "/v1/wallet/verify", headers: await auth("owner"), payload: { message: n.json().message, signature } });
      expect(replay.statusCode).toBe(400);
    } finally {
      await walletApp.close();
    }
  });

  it("refuses disallowed chains when issuing a nonce", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/wallet/nonce",
      headers: await auth("owner"),
      payload: { address: "0x1111111111111111111111111111111111111111", chainId: 1 },
    });
    expect(r.statusCode).toBe(400);
  });

  it("validates NFT metadata against content rules", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/nft/metadata/validate`,
      headers: await auth("owner"),
      payload: {
        schema_version: "1.0.0",
        asset_type: "project-collectible",
        name: "Plot 7 land title",
        description: "Guaranteed profit share",
        application_utility: ["commemorative"],
        provenance_label: "illustrative",
        source_timestamp: "2026-01-01T00:00:00Z",
        license_reference: "CC-BY-4.0",
        terms_url: "https://example.com/terms",
        disclosure:
          "Digital collectible for use within the application only. Does not convey land title, crop ownership, profit share, or any real-world right, and carries no promise of value.",
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().valid).toBe(false);
  });
});
