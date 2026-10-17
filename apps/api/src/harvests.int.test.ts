/**
 * Harvest batches against a real database: who may record and void, the
 * immutable public record, and the public verification endpoint.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { harvestChainId, harvestRecordHash } from "@metafarm/domain";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("harvest traceability", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let chainApp: FastifyInstance;
  let jobs: Awaited<ReturnType<typeof buildTestApp>>["jobs"];
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `h-owner-${sfx}`, worker: `h-worker-${sfx}`, viewer: `h-viewer-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let farmId: string;
  const auth = async (who: keyof typeof subjects) => ({ authorization: `Bearer ${await tokenFor(subjects[who])}` });
  const base = () => `/v1/tenants/${tenantId}/farms/${farmId}/harvests`;
  const batch = { cropName: "Pistachio", parcelLabel: "Block 3", harvestedOn: "2026-09-20", quantity: "1250.500", unit: "kg", notes: "sold to the co-op" };
  const onChain = new Map<string, { recordHash: string; recordedAt: bigint; voidedAt: bigint }>();

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `harvest-${sfx}`, name: "Hashemizadegan", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'worker'), ($1, $3, 'viewer')`, [tenantId, ids.worker, ids.viewer]);
    const now = () => new Date("2026-09-21T08:15:30.789Z");
    ({ app } = await buildTestApp({ pool, deps: { now } }));
    ({ app: chainApp, jobs } = await buildTestApp({
      pool,
      env: { CHAIN_RPC_URL: "http://127.0.0.1:8545", HARVEST_REGISTRY_ADDRESS: `0x${"1".repeat(40)}`, CHAIN_NAME: "Testnet", CHAIN_EXPLORER_TX_URL: "https://explorer.invalid/tx/" },
      deps: { now, harvestChain: { entryOf: async (id) => onChain.get(id) ?? { recordHash: `0x${"0".repeat(64)}`, recordedAt: 0n, voidedAt: 0n } } },
    }));
    const r = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: await auth("owner"), payload: { name: "Rafsanjan orchard" } });
    farmId = r.json().id;
  });

  afterAll(async () => {
    await app?.close();
    await chainApp?.close();
    await pool?.end();
  });

  it("lets workers record harvests but not viewers", async () => {
    expect((await app.inject({ method: "POST", url: base(), headers: await auth("viewer"), payload: batch })).statusCode).toBe(403);
    const r = await app.inject({ method: "POST", url: base(), headers: await auth("worker"), payload: batch });
    expect(r.statusCode).toBe(201);
    const h = r.json();
    expect(h.code).toMatch(/^[2-9A-HJKMNP-Z]{10}$/);
    expect(h.anchor.status).toBe("not_configured");
    expect(h.publicRecord).toEqual({
      v: 1,
      batch: h.code,
      producer: "Hashemizadegan",
      farm: "Rafsanjan orchard",
      crop: "Pistachio",
      parcel: "Block 3",
      harvestedOn: "2026-09-20",
      quantity: "1250.5",
      unit: "kg",
      grade: null,
      recordedAt: "2026-09-21T08:15:30.000Z",
    });
    expect(h.recordHash).toBe(await harvestRecordHash(h.publicRecord));
  });

  it("never lets the public record change", async () => {
    await expect(pool.query(`UPDATE harvest_batches SET quantity = 9999 WHERE tenant_id = $1`, [tenantId])).rejects.toThrow(/immutable/);
  });

  it("serves the public record without sign-in, but not private notes", async () => {
    const h = (await app.inject({ method: "GET", url: base(), headers: await auth("viewer") })).json().items[0];
    const r = await app.inject({ method: "GET", url: `/v1/public/harvests/${h.code}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ code: h.code, recordHash: h.recordHash, chainCheck: null, anchor: { status: "not_configured" } });
    expect(r.body).not.toContain("co-op");
    expect((await app.inject({ method: "GET", url: "/v1/public/harvests/ZZZZZZZZZZ" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/public/harvests/not-a-code" })).statusCode).toBe(400);
  });

  it("queues registration when the registry is configured and checks the chain live", async () => {
    const r = await chainApp.inject({ method: "POST", url: base(), headers: await auth("owner"), payload: { ...batch, quantity: "40" } });
    const h = r.json();
    expect(h.anchor.status).toBe("pending");
    expect(jobs.jobs.some((j) => j.queue === "harvest-anchoring" && (j.payload as { batchId: string }).batchId === h.id)).toBe(true);

    // Simulate the worker's result, then the public check sees a matching fingerprint on-chain.
    await pool.query(`UPDATE harvest_batches SET anchor_status = 'confirmed', anchor_tx_hash = $2, anchor_chain_id = 84532 WHERE id = $1`, [h.id, `0x${"a".repeat(64)}`]);
    onChain.set(harvestChainId(h.id), { recordHash: `0x${h.recordHash}`, recordedAt: 1_790_000_000n, voidedAt: 0n });
    const pub = (await chainApp.inject({ method: "GET", url: `/v1/public/harvests/${h.code}` })).json();
    expect(pub.chainCheck).toMatchObject({ matches: true, voidedOnChain: false });
    expect(pub.anchor).toMatchObject({ status: "confirmed", chainName: "Testnet", explorerUrl: `https://explorer.invalid/tx/0x${"a".repeat(64)}` });

    // A different on-chain fingerprint is reported, never hidden.
    onChain.set(harvestChainId(h.id), { recordHash: `0x${"b".repeat(64)}`, recordedAt: 1n, voidedAt: 0n });
    expect((await chainApp.inject({ method: "GET", url: `/v1/public/harvests/${h.code}` })).json().chainCheck.matches).toBe(false);

    // Voiding a registered batch queues the on-chain void.
    expect((await chainApp.inject({ method: "POST", url: `${base()}/${h.id}/void`, headers: await auth("worker"), payload: { reason: "recorded twice" } })).statusCode).toBe(403);
    const v = await chainApp.inject({ method: "POST", url: `${base()}/${h.id}/void`, headers: await auth("owner"), payload: { reason: "recorded twice" } });
    expect(v.json()).toMatchObject({ voidReason: "recorded twice", voidAnchorStatus: "pending" });
    expect(jobs.jobs.some((j) => j.queue === "harvest-anchoring" && (j.payload as { action: string }).action === "void")).toBe(true);
    expect((await chainApp.inject({ method: "POST", url: `${base()}/${h.id}/void`, headers: await auth("owner"), payload: { reason: "again" } })).statusCode).toBe(409);
  });
});
