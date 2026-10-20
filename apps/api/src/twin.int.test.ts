/**
 * Digital-twin API: role restrictions, validation, idempotency, ownership read only from the chain
 * (or an indexer of it), Merkle proofs re-checked on read, and transfer previews that never submit.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FIXTURE_ASSETS, FIXTURE_EVENTS, FIXTURE_WALLETS, createFixtureLedger } from "@metafarm/chain";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, withTenant, type Pool } from "@metafarm/db";
import { twinSceneSchema, verifyMerkleInclusion } from "@metafarm/domain";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const hash = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const KEY = () => crypto.randomUUID();

d("digital twin API", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let indexed: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `tw-owner-${sfx}`, admin: `tw-admin-${sfx}`, manager: `tw-manager-${sfx}`, viewer: `tw-viewer-${sfx}`, stranger: `tw-stranger-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let otherTenantId: string;
  let farmId: string;
  const assets: string[] = [];
  let shareRep: string;
  let plannedRep: string;

  const req = async (a: FastifyInstance, who: keyof typeof subjects, method: "GET" | "POST", path: string, payload?: object, headers: Record<string, string> = {}) =>
    a.inject({ method, url: `/v1/tenants/${tenantId}/twin${path}`, headers: { authorization: `Bearer ${await tokenFor(subjects[who])}`, ...headers }, ...(payload ? { payload } : {}) });
  const call = (who: keyof typeof subjects, method: "GET" | "POST", path: string, payload?: object, headers?: Record<string, string>) => req(app, who, method, path, payload, headers);
  const commitment = (n: number, extra: object = {}) => ({
    subjectType: "asset",
    subjectId: assets[0]!,
    schema: "metafarm.survey",
    schemaVersion: 1,
    contentSha256: hash(n),
    sourceTime: "2026-10-20T10:00:00Z",
    ...extra,
  });

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `tw-${sfx}`, name: "Twin", ownerUserId: ids.owner! }));
    otherTenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `tw2-${sfx}`, name: "Other", ownerUserId: ids.stranger! }));
    for (const role of ["admin", "manager", "viewer"] as const)
      await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [tenantId, ids[role], role]);
    ({ app } = await buildTestApp({ pool }));
    ({ app: indexed } = await buildTestApp({ pool, deps: { ownershipReader: createFixtureLedger(FIXTURE_EVENTS) } }));
    farmId = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: { authorization: `Bearer ${await tokenFor(subjects.owner)}` }, payload: { name: "Grove" } })).json().id;
    for (const [kind, name, geometry] of [
      ["parcel", "Block A", { type: "Polygon", coordinates: [[[56.0, 30.4], [56.001, 30.4], [56.001, 30.401], [56.0, 30.4]]] }],
      ["building", "Packing shed", null],
      ["storage_unit", "Cold store 1", null],
    ] as const) {
      const r = await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/rwa/assets`,
        headers: { authorization: `Bearer ${await tokenFor(subjects.owner)}` },
        payload: { farmId, kind, name, ...(geometry ? { geometry, geomProvenance: "surveyed" } : {}) },
      });
      expect(r.statusCode).toBe(201);
      assets.push(r.json().id);
    }
    // Chain identities written as the engine would (the API has no route that sets them directly).
    shareRep = (
      await pool.query<{ id: string }>(
        `INSERT INTO asset_representations (tenant_id, asset_id, rail, network, status, mint_address, decimals) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'solana-devnet', 'active', $3, 6) RETURNING id`,
        [tenantId, assets[1], FIXTURE_ASSETS.shareMint.id],
      )
    ).rows[0]!.id;
    plannedRep = (
      await pool.query<{ id: string }>(`INSERT INTO asset_representations (tenant_id, asset_id, rail, network, status) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'solana-devnet', 'planned') RETURNING id`, [tenantId, assets[2]])
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await app?.close();
    await indexed?.close();
    await pool?.end();
  });

  describe("scene", () => {
    it("lists a farm's assets on their layers, with chain identities, in the published shape", async () => {
      const r = await call("manager", "GET", `/farms/${farmId}/scene`);
      expect(r.statusCode).toBe(200);
      const scene = twinSceneSchema.parse(r.json());
      expect(scene.redacted).toEqual([]);
      expect(scene.objects.map((o) => [o.kind, o.layer])).toEqual([
        ["parcel", "plots"],
        ["building", "buildings"],
        ["storage_unit", "storage"],
      ]);
      expect(scene.objects[0]!.geometry).toMatchObject({ type: "Polygon" });
      expect(scene.objects[1]!.chain).toEqual([{ representationId: shareRep, rail: "SOLANA_TOKEN_2022", network: "solana-devnet", status: "active", chainId: FIXTURE_ASSETS.shareMint.id }]);
    });

    it("pages with a cursor", async () => {
      const first = (await call("owner", "GET", `/farms/${farmId}/scene?limit=2`)).json();
      expect(first.objects).toHaveLength(2);
      const second = (await call("owner", "GET", `/farms/${farmId}/scene?limit=2&cursor=${first.nextCursor}`)).json();
      expect(second.objects.map((o: { assetId: string }) => o.assetId)).toEqual([assets[2]]);
      expect(second.nextCursor).toBeNull();
    });

    it("shows a viewer the farm but withholds every asset layer", async () => {
      const r = (await call("viewer", "GET", `/farms/${farmId}/scene`)).json();
      expect(r.farm.id).toBe(farmId);
      expect(r.objects).toEqual([]);
      expect(r.redacted).toContain("plots");
      expect(r.redacted).not.toContain("terrain");
    });

    it("hides other workspaces and rejects bad input", async () => {
      expect((await call("stranger", "GET", `/farms/${farmId}/scene`)).statusCode).toBe(404);
      expect((await call("owner", "GET", `/farms/${farmId}/scene?limit=0`)).statusCode).toBe(400);
      expect((await call("owner", "GET", `/farms/not-a-uuid/scene`)).statusCode).toBe(400);
      expect((await call("owner", "GET", `/farms/${otherTenantId}/scene`)).statusCode).toBe(404);
    });
  });

  describe("asset detail and ownership", () => {
    it("needs rwa:read", async () => {
      expect((await call("viewer", "GET", `/assets/${assets[0]}`)).statusCode).toBe(403);
      expect((await call("manager", "GET", `/assets/${assets[0]}`)).statusCode).toBe(200);
    });

    it("never substitutes its own records for chain ownership", async () => {
      const shed = (await call("manager", "GET", `/assets/${assets[1]}`)).json();
      expect(shed.ownership).toEqual([{ representationId: shareRep, status: "not_indexed", reason: "no_ownership_reader" }]);
      const store = (await call("manager", "GET", `/assets/${assets[2]}`)).json();
      expect(store.ownership).toEqual([{ representationId: plannedRep, status: "not_on_chain" }]);
      expect(store.lifecycle).toEqual([{ event: "registered", at: expect.any(String) }]);
    });

    it("reports holders from an ownership reader, labelled with its source and assurance", async () => {
      const shed = (await req(indexed, "manager", "GET", `/assets/${assets[1]}`)).json();
      expect(shed.ownership[0]).toMatchObject({ status: "indexed", source: "fixture", assurance: "fixture", asOfSlot: "310000900" });
      expect(shed.ownership[0].holders).toContainEqual({ owner: FIXTURE_WALLETS.investor, amount: "250000" });
    });
  });

  describe("data commitments", () => {
    it("are recorded by operators only, once per fact", async () => {
      expect((await call("manager", "POST", "/data-commitments", commitment(1))).statusCode).toBe(403);
      const first = await call("admin", "POST", "/data-commitments", commitment(1, { storageRef: `sha256:${hash(1)}` }));
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ subjectType: "asset", contentSha256: hash(1), batch: null, storageRef: `sha256:${hash(1)}` });
      const again = await call("owner", "POST", "/data-commitments", commitment(1));
      expect(again.statusCode).toBe(200);
      expect(again.json().id).toBe(first.json().id);
    });

    it("replays a resend with the same Idempotency-Key and refuses the key for another request", async () => {
      const key = KEY();
      const a = await call("admin", "POST", "/data-commitments", commitment(2), { "idempotency-key": key });
      const b = await call("admin", "POST", "/data-commitments", commitment(2), { "idempotency-key": key });
      expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
      expect(b.json().id).toBe(a.json().id);
      expect((await call("admin", "POST", "/data-commitments", commitment(3), { "idempotency-key": key })).json()).toMatchObject({ error: "idempotency_key_reused" });
      expect((await call("admin", "POST", "/data-commitments", commitment(3), { "idempotency-key": "nope" })).statusCode).toBe(400);
    });

    it("validates hashes, subjects and content-addressed storage references", async () => {
      const bad = async (body: object) => (await call("admin", "POST", "/data-commitments", body)).json().error;
      expect(await bad(commitment(4, { contentSha256: "ABC" }))).toBe("invalid_request");
      expect(await bad(commitment(4, { verified: true }))).toBe("invalid_request");
      expect(await bad(commitment(4, { subjectId: farmId }))).toBe("unknown_subject");
      expect(await bad(commitment(4, { storageRef: "s3://farm-media/photo.jpg" }))).toBe("storage_ref_not_content_addressed");
      expect(await bad(commitment(4, { storageRef: `sha256:${hash(5)}` }))).toBe("storage_ref_not_content_addressed");
      expect((await call("admin", "POST", "/data-commitments", commitment(4, { storageRef: `s3://farm-media/tenants/x/${hash(4)}.json` }))).statusCode).toBe(201);
    });

    it("lists newest first with a cursor, readable with rwa:read only", async () => {
      expect((await call("viewer", "GET", "/data-commitments")).statusCode).toBe(403);
      const page = (await call("manager", "GET", `/data-commitments?subjectType=asset&subjectId=${assets[0]}&limit=2`)).json();
      expect(page.items).toHaveLength(2);
      const rest = (await call("manager", "GET", `/data-commitments?subjectType=asset&subjectId=${assets[0]}&limit=2&cursor=${page.nextCursor}`)).json();
      expect(rest.items.length).toBeGreaterThan(0);
      expect(new Set([...page.items, ...rest.items].map((c: { id: string }) => c.id)).size).toBe(page.items.length + rest.items.length);
    });

    it("cannot be changed by the application role", async () => {
      await expect(withTenant(pool, tenantId, (tx) => tx.query(`UPDATE data_commitments SET content_sha256 = $2 WHERE tenant_id = $1`, [tenantId, hash(9)]))).rejects.toThrow(/permission denied/);
      await expect(withTenant(pool, tenantId, (tx) => tx.query(`DELETE FROM data_commitments WHERE tenant_id = $1`, [tenantId]))).rejects.toThrow(/permission denied/);
    });
  });

  describe("Merkle batches and proofs", () => {
    let batched: string[] = [];

    it("fixes a batch, then proves each member against its root", async () => {
      const made = await Promise.all([10, 11, 12].map(async (n) => (await call("admin", "POST", "/data-commitments", commitment(n))).json().id as string));
      batched = made;
      const key = KEY();
      const r = await call("admin", "POST", "/data-commitments/batches", { dataset: "survey/2026-10", commitmentIds: made }, { "idempotency-key": key });
      expect(r.statusCode).toBe(201);
      expect(r.json()).toMatchObject({ dataset: "survey/2026-10", scheme: "metafarm-merkle-sha256/1", leafCount: 3, anchor: null });
      const replay = await call("admin", "POST", "/data-commitments/batches", { dataset: "survey/2026-10", commitmentIds: made }, { "idempotency-key": key });
      expect([replay.statusCode, replay.json().id]).toEqual([200, r.json().id]);

      for (const [i, id] of made.entries()) {
        const p = (await call("manager", "GET", `/data-commitments/${id}/proof`)).json();
        expect(p.state).toBe("included");
        expect(p.anchor).toBeNull();
        expect(p.proof).toMatchObject({ leafIndex: i, size: 3, root: r.json().merkleRoot });
        expect(await verifyMerkleInclusion({ leaf: p.proof.leaf, index: p.proof.leafIndex, size: p.proof.size, path: p.proof.path, root: p.proof.root })).toBe(true);
      }
    });

    it("refuses duplicates, unknown ids, a second batch for a member, and non-operators", async () => {
      const lone = (await call("admin", "POST", "/data-commitments", commitment(20))).json().id;
      expect((await call("admin", "POST", "/data-commitments/batches", { dataset: "x", commitmentIds: [lone, lone] })).json().error).toBe("duplicate_commitments");
      expect((await call("admin", "POST", "/data-commitments/batches", { dataset: "x", commitmentIds: [lone, KEY()] })).json().error).toBe("unknown_commitments");
      expect((await call("admin", "POST", "/data-commitments/batches", { dataset: "x", commitmentIds: [lone, batched[0]] })).json().error).toBe("already_batched");
      expect((await call("manager", "POST", "/data-commitments/batches", { dataset: "x", commitmentIds: [lone] })).statusCode).toBe(403);
      const p = (await call("manager", "GET", `/data-commitments/${lone}/proof`)).json();
      expect([p.state, p.proof]).toEqual(["recorded", null]);
    });

    it("stops claiming inclusion when the stored batch no longer matches", async () => {
      // Tamper as the database owner (the application role cannot): the proof must notice.
      await pool.query(`UPDATE commitment_batch_leaves SET leaf_hash = $2 WHERE commitment_id = $1`, [batched[1], hash(99)]);
      const p = (await call("manager", "GET", `/data-commitments/${batched[0]}/proof`)).json();
      expect(p.state).toBe("recorded");
      expect(p.checks).toMatchObject({ leavesMatchCommitments: false, inclusionVerified: false });
    });
  });

  describe("transfer preview", () => {
    const body = (extra: object = {}) => ({ representationId: shareRep, from: FIXTURE_WALLETS.custodian, to: FIXTURE_WALLETS.buyer, amount: "1000", ...extra });

    it("is refused while ownership is not indexed", async () => {
      expect((await call("admin", "POST", "/transfers/preview", body())).json()).toMatchObject({ error: "ownership_not_indexed" });
      expect((await call("admin", "POST", "/transfers/preview", body({ representationId: plannedRep }))).json()).toMatchObject({ error: "not_on_chain" });
    });

    it("prepares a fingerprinted preview from chain holders and never offers submission", async () => {
      const r = await req(indexed, "admin", "POST", "/transfers/preview", body());
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ representationId: shareRep, amount: "1000", ownershipAsOfSlot: "310000900", submission: { available: false, reason: "not_enabled" } });
      expect(r.json().digest).toMatch(/^[0-9a-f]{64}$/);
      expect((await req(indexed, "admin", "POST", "/transfers/preview", body({ from: FIXTURE_WALLETS.buyer, to: FIXTURE_WALLETS.custodian }))).json().error).toBe("sender_not_holder");
    });

    it("needs rwa:operate and well-formed input", async () => {
      expect((await req(indexed, "manager", "POST", "/transfers/preview", body())).statusCode).toBe(403);
      expect((await req(indexed, "admin", "POST", "/transfers/preview", body({ amount: "0" }))).statusCode).toBe(400);
      expect((await req(indexed, "admin", "POST", "/transfers/preview", body({ to: "0xdeadbeef" }))).statusCode).toBe(400);
      expect((await req(indexed, "admin", "POST", "/transfers/preview", body({ representationId: KEY() }))).statusCode).toBe(404);
    });
  });

  describe("chain work and sync status", () => {
    it("reports what is and is not configured", async () => {
      const s = (await call("manager", "GET", "/sync-status")).json();
      expect(s.ownership).toEqual({ status: "not_configured", source: null });
      expect(s.submission).toEqual({ available: false, reason: "not_enabled" });
      expect(s.representations).toEqual({ total: 2, withChainId: 1, active: 1 });
      expect(s.dataCommitments.anchoredBatches).toBe(0);
      expect((await req(indexed, "manager", "GET", "/sync-status")).json().ownership).toEqual({ status: "configured", source: "fixture" });
      expect((await call("viewer", "GET", "/sync-status")).statusCode).toBe(403);
    });

    it("hides transactions of other workspaces", async () => {
      expect((await call("manager", "GET", `/transactions/${KEY()}`)).statusCode).toBe(404);
    });
  });
});
