/**
 * API authorization and workflow integration tests against a real
 * PostgreSQL + PostGIS database (DATABASE_URL). Queue and storage are in-memory.
 */
import { createHash } from "node:crypto";
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

  it("accepts upload bytes through the API in proxy mode and checks them", async () => {
    const { app: proxyApp } = await buildTestApp({ pool, env: { UPLOAD_MODE: "proxy" } });
    try {
      const bytes = Buffer.from('{"type":"FeatureCollection","features":[]}');
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const ticket = (
        await proxyApp.inject({
          method: "POST",
          url: `/v1/tenants/${tenantId}/uploads`,
          headers: await auth("owner"),
          payload: { filename: "b.geojson", contentType: "application/geo+json", byteSize: bytes.length, purpose: "boundary-import", sha256 },
        })
      ).json();
      expect(ticket.uploadUrl).toContain(`/v1/tenants/${tenantId}/uploads/${ticket.mediaId}/content`);
      const contentPath = new URL(ticket.uploadUrl).pathname;

      const tampered = await proxyApp.inject({
        method: "PUT",
        url: contentPath,
        headers: { ...(await auth("owner")), "content-type": "application/geo+json" },
        payload: Buffer.from('{"type":"FeatureCollection","features":[1]}'),
      });
      expect(tampered.statusCode).toBe(422);

      const viewer = await proxyApp.inject({
        method: "PUT",
        url: contentPath,
        headers: { ...(await auth("viewer")), "content-type": "application/geo+json" },
        payload: bytes,
      });
      expect(viewer.statusCode).toBe(403);

      const put = await proxyApp.inject({
        method: "PUT",
        url: contentPath,
        headers: { ...(await auth("owner")), "content-type": "application/geo+json" },
        payload: bytes,
      });
      expect(put.statusCode).toBe(204);

      const done = await proxyApp.inject({ method: "POST", url: `/v1/tenants/${tenantId}/uploads/${ticket.mediaId}/complete`, headers: await auth("owner") });
      expect(done.statusCode).toBe(200);
      expect(done.json().status).toBe("uploaded");
    } finally {
      await proxyApp.close();
    }
  });

  it("does not expose the upload content route in direct mode", async () => {
    const r = await app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/uploads/00000000-0000-4000-8000-000000000000/content`,
      headers: { ...(await auth("owner")), "content-type": "image/png" },
      payload: Buffer.from("x"),
    });
    expect(r.statusCode).toBe(404);
  });

  it("lets a signed-in user create a workspace up to the configured cap", async () => {
    const { app: wsApp } = await buildTestApp({ pool, env: { MAX_OWNED_WORKSPACES: "2" } });
    const newbie = { authorization: `Bearer ${await tokenFor(`newbie-${sfx}`)}` };
    try {
      const empty = await wsApp.inject({ method: "GET", url: "/v1/me", headers: newbie });
      expect(empty.json().tenants).toEqual([]);

      const first = await wsApp.inject({ method: "POST", url: "/v1/me/workspaces", headers: newbie, payload: { name: "Ferme du Lac" } });
      expect(first.statusCode).toBe(201);
      expect(first.json().slug).toMatch(/^ferme-du-lac-[0-9a-f]{8}$/);

      const me = await wsApp.inject({ method: "GET", url: "/v1/me", headers: newbie });
      expect(me.json().tenants).toEqual([expect.objectContaining({ tenantId: first.json().tenantId, role: "owner" })]);

      const farms = await wsApp.inject({ method: "GET", url: `/v1/tenants/${first.json().tenantId}/farms`, headers: newbie });
      expect(farms.statusCode).toBe(200);

      expect((await wsApp.inject({ method: "POST", url: "/v1/me/workspaces", headers: newbie, payload: { name: "Second" } })).statusCode).toBe(201);
      const third = await wsApp.inject({ method: "POST", url: "/v1/me/workspaces", headers: newbie, payload: { name: "Third" } });
      expect(third.statusCode).toBe(409);

      const blank = await wsApp.inject({ method: "POST", url: "/v1/me/workspaces", headers: newbie, payload: { name: "  " } });
      expect(blank.statusCode).toBe(400);
    } finally {
      await wsApp.close();
    }
  });

  it("refuses self-service workspaces when disabled, and requires sign-in", async () => {
    const { app: offApp } = await buildTestApp({ pool, env: { SELF_SERVE_WORKSPACES: "false" } });
    try {
      const off = await offApp.inject({ method: "POST", url: "/v1/me/workspaces", headers: await auth("viewer"), payload: { name: "X" } });
      expect(off.statusCode).toBe(403);
      const anon = await offApp.inject({ method: "POST", url: "/v1/me/workspaces", payload: { name: "X" } });
      expect(anon.statusCode).toBe(401);
    } finally {
      await offApp.close();
    }
  });

  it("edits, archives and restores a farm", async () => {
    const h = await auth("owner");
    const created = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: h, payload: { name: "To edit" } })).json();
    const edited = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantId}/farms/${created.id}`,
      headers: h,
      payload: { name: "Edited", description: "North field", timezone: "Asia/Tehran" },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ name: "Edited", description: "North field", timezone: "Asia/Tehran", archivedAt: null });

    const badTz = await app.inject({ method: "PATCH", url: `/v1/tenants/${tenantId}/farms/${created.id}`, headers: h, payload: { timezone: "Mars/Olympus" } });
    expect(badTz.statusCode).toBe(400);
    const viewer = await app.inject({ method: "PATCH", url: `/v1/tenants/${tenantId}/farms/${created.id}`, headers: await auth("viewer"), payload: { name: "x" } });
    expect(viewer.statusCode).toBe(403);

    const archived = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms/${created.id}/archive`, headers: h });
    expect(archived.json().archivedAt).not.toBeNull();
    const active = (await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/farms?limit=100`, headers: h })).json();
    expect(active.items.map((f: { id: string }) => f.id)).not.toContain(created.id);
    const archivedList = (await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/farms?status=archived`, headers: h })).json();
    expect(archivedList.items.map((f: { id: string }) => f.id)).toContain(created.id);

    const restored = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms/${created.id}/restore`, headers: h });
    expect(restored.json().archivedAt).toBeNull();
  });

  it("invites by single-use link and enforces role-change rules", async () => {
    const h = await auth("owner");
    const members = (await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/members`, headers: await auth("viewer") })).json();
    expect(members.items.map((m: { role: string }) => m.role)).toEqual(expect.arrayContaining(["owner", "viewer", "verifier"]));

    expect((await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/invitations`, headers: await auth("viewer"), payload: { email: "a@b.co", role: "viewer" } })).statusCode).toBe(403);

    const inv = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/invitations`, headers: h, payload: { email: "New.Person@Example.com", role: "manager" } });
    expect(inv.statusCode).toBe(201);
    const { token, email, id: invitationId } = inv.json();
    expect(email).toBe("new.person@example.com");
    const stored = await pool.query(`SELECT token_hash FROM invitations WHERE id = $1`, [invitationId]);
    expect(stored.rows[0].token_hash).not.toBe(token);

    const pending = (await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/invitations`, headers: h })).json();
    expect(pending.items.map((i: { id: string }) => i.id)).toContain(invitationId);

    const joiner = { authorization: `Bearer ${await tokenFor(`joiner-${sfx}`)}` };
    const accepted = await app.inject({ method: "POST", url: "/v1/me/invitations/accept", headers: joiner, payload: { token } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ tenantId, role: "manager", alreadyMember: false });
    const again = await app.inject({ method: "POST", url: "/v1/me/invitations/accept", headers: joiner, payload: { token } });
    expect(again.statusCode).toBe(410);
    const bogus = await app.inject({ method: "POST", url: "/v1/me/invitations/accept", headers: joiner, payload: { token: "x".repeat(40) } });
    expect(bogus.statusCode).toBe(404);

    const joinerId = (await app.inject({ method: "GET", url: "/v1/me", headers: joiner })).json().userId;
    // A manager cannot manage members; the owner can.
    expect((await app.inject({ method: "PATCH", url: `/v1/tenants/${tenantId}/members/${joinerId}`, headers: joiner, payload: { role: "admin" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/v1/tenants/${tenantId}/members/${joinerId}`, headers: h, payload: { role: "admin" } })).statusCode).toBe(200);

    // An admin cannot grant owner, and the last owner cannot be demoted or removed.
    expect((await app.inject({ method: "PATCH", url: `/v1/tenants/${tenantId}/members/${joinerId}`, headers: joiner, payload: { role: "owner" } })).statusCode).toBe(403);
    const ownerId = (await app.inject({ method: "GET", url: "/v1/me", headers: h })).json().userId;
    expect((await app.inject({ method: "PATCH", url: `/v1/tenants/${tenantId}/members/${ownerId}`, headers: h, payload: { role: "admin" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/v1/tenants/${tenantId}/members/${ownerId}`, headers: h })).statusCode).toBe(409);

    // Members can leave on their own.
    expect((await app.inject({ method: "DELETE", url: `/v1/tenants/${tenantId}/members/${joinerId}`, headers: joiner })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/farms`, headers: joiner })).statusCode).toBe(404);

    // Revoked invitations cannot be used.
    const inv2 = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/invitations`, headers: h, payload: { email: "c@d.co", role: "viewer" } })).json();
    expect((await app.inject({ method: "DELETE", url: `/v1/tenants/${tenantId}/invitations/${inv2.id}`, headers: h })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/v1/me/invitations/accept", headers: joiner, payload: { token: inv2.token } })).statusCode).toBe(404);
  });

  it("renames the workspace and updates the caller's profile", async () => {
    const renamed = await app.inject({ method: "PATCH", url: `/v1/tenants/${tenantId}/settings`, headers: await auth("owner"), payload: { name: "Renamed T" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("Renamed T");
    expect((await app.inject({ method: "PATCH", url: `/v1/tenants/${tenantId}/settings`, headers: await auth("viewer"), payload: { name: "Nope" } })).statusCode).toBe(403);

    const profile = await app.inject({ method: "PATCH", url: "/v1/me/profile", headers: await auth("viewer"), payload: { displayName: "Vera Viewer", email: "Vera@Example.com" } });
    expect(profile.json()).toEqual({ displayName: "Vera Viewer", email: "vera@example.com" });
    const members = (await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/members`, headers: await auth("owner") })).json();
    expect(members.items).toEqual(expect.arrayContaining([expect.objectContaining({ displayName: "Vera Viewer", role: "viewer" })]));
  });

  it("lists a farm's files and serves their bytes only to members", async () => {
    const { app: proxyApp } = await buildTestApp({ pool, env: { UPLOAD_MODE: "proxy" } });
    try {
      const h = await auth("verifier");
      const bytes = Buffer.from("%PDF-1.4 test");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const t = (
        await proxyApp.inject({
          method: "POST",
          url: `/v1/tenants/${tenantId}/uploads`,
          headers: h,
          payload: { filename: "survey <1>.pdf", contentType: "application/pdf", byteSize: bytes.length, purpose: "verification-evidence", sha256, farmId },
        })
      ).json();
      expect(t.mediaId).toBeDefined();
      await proxyApp.inject({ method: "PUT", url: new URL(t.uploadUrl).pathname, headers: { ...h, "content-type": "application/pdf" }, payload: bytes });
      await proxyApp.inject({ method: "POST", url: `/v1/tenants/${tenantId}/uploads/${t.mediaId}/complete`, headers: h });

      const list = (await proxyApp.inject({ method: "GET", url: `/v1/tenants/${tenantId}/farms/${farmId}/media?purpose=verification-evidence`, headers: await auth("viewer") })).json();
      expect(list.items.map((m: { id: string }) => m.id)).toContain(t.mediaId);

      const file = await proxyApp.inject({ method: "GET", url: `/v1/tenants/${tenantId}/media/${t.mediaId}/content`, headers: await auth("viewer") });
      expect(file.statusCode).toBe(200);
      expect(file.rawPayload.equals(bytes)).toBe(true);
      expect(file.headers["content-disposition"]).toBe('inline; filename="survey _1_.pdf"');
      expect(file.headers["x-content-type-options"]).toBe("nosniff");

      const outsider = await proxyApp.inject({ method: "GET", url: `/v1/tenants/${tenantId}/media/${t.mediaId}/content`, headers: await auth("outsider") });
      expect(outsider.statusCode).toBe(404);
    } finally {
      await proxyApp.close();
    }
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
