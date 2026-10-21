/** The twin API reading ownership from the platform's ownership index (migration 0020), read-only. */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  advanceOwnershipCursor,
  createPool,
  createTenantWithOwner,
  insertOwnershipEvents,
  migrateUp,
  readOwnershipIndex,
  upsertUserBySubject,
  withSystem,
  type Pool,
} from "@metafarm/db";
import type { ChainAssetRef, OwnershipEvent } from "@metafarm/domain";
import { IndexOwnershipReader, base58Encode } from "@metafarm/chain";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

// The index is global: this file's asset and wallets are random so it never meets other test files.
const b58 = (n: number) => base58Encode(randomBytes(n));
const share: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: b58(32) };
const unindexed: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: b58(32) };
const w = { custodian: b58(32), investor: b58(32), buyer: b58(32) };
const ev = (kind: OwnershipEvent["kind"], from: string | null, to: string | null, amount: bigint, slot: bigint): OwnershipEvent => ({
  asset: share, kind, from, to, amount, slot, txIndex: 0, ixIndex: 0, signature: b58(64),
});

d("twin API with the ownership index", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let shed: string;
  let store: string;
  let shareRep: string;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `oix-owner-${sfx}`, admin: `oix-admin-${sfx}`, manager: `oix-manager-${sfx}` };
  const ids: Record<string, string> = {};
  const call = async (who: keyof typeof subjects, method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: `/v1/tenants/${tenantId}/twin${path}`, headers: { authorization: `Bearer ${await tokenFor(subjects[who])}` }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `oix-${sfx}`, name: "OIX", ownerUserId: ids.owner! }));
    for (const role of ["admin", "manager"] as const) await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [tenantId, ids[role], role]);
    // The API exactly as main.ts builds it when TWIN_OWNERSHIP_INDEX_ENABLED is set.
    ({ app } = await buildTestApp({ pool, deps: { ownershipReader: new IndexOwnershipReader((a) => readOwnershipIndex(pool, a)) } }));
    const owner = { authorization: `Bearer ${await tokenFor(subjects.owner)}` };
    const farmId = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: owner, payload: { name: "Grove" } })).json().id;
    [shed, store] = await Promise.all(
      (["Packing shed", "Cold store"] as const).map(async (name, i) =>
        (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/rwa/assets`, headers: owner, payload: { farmId, kind: i === 0 ? "building" : "storage_unit", name } })).json().id as string,
      ),
    );
    shareRep = (
      await pool.query<{ id: string }>(
        `INSERT INTO asset_representations (tenant_id, asset_id, rail, network, status, mint_address, decimals) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'solana-devnet', 'active', $3, 6) RETURNING id`,
        [tenantId, shed, share.id],
      )
    ).rows[0]!.id;
    await pool.query(`INSERT INTO asset_representations (tenant_id, asset_id, rail, network, status, mint_address, decimals) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'solana-devnet', 'active', $3, 6)`, [tenantId, store, unindexed.id]);
    // Indexed as the ownership-index job would: events, then the cursor, in one system transaction.
    await withSystem(pool, async (tx) => {
      await insertOwnershipEvents(tx, [ev("mint", null, w.custodian, 1_000_000n, 100n), ev("transfer", w.custodian, w.investor, 250_000n, 900n)], "fixture");
      await advanceOwnershipCursor(tx, share, 1_000n, "fixture");
    });
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("reports holders from the index, as of the slot it is indexed through", async () => {
    const r = await call("manager", "GET", `/assets/${shed}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().ownership).toEqual([
      {
        representationId: shareRep,
        status: "indexed",
        source: "chain_index",
        assurance: "indexer_reported",
        asOfSlot: "1000",
        holders: [
          { owner: w.custodian, amount: "750000" },
          { owner: w.investor, amount: "250000" },
        ].sort((a, b) => (a.owner < b.owner ? -1 : 1)),
      },
    ]);
  });

  it("says not_indexed for an asset the index does not cover, never 'no owner'", async () => {
    const r = (await call("manager", "GET", `/assets/${store}`)).json();
    expect(r.ownership[0]).toMatchObject({ status: "not_indexed", reason: "not_covered" });
  });

  it("prepares transfer previews from indexed holders; submission stays unavailable", async () => {
    const body = { representationId: shareRep, from: w.custodian, to: w.buyer, amount: "1000" };
    const r = await call("admin", "POST", "/transfers/preview", body);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ownershipAsOfSlot: "1000", submission: { available: false, reason: "not_enabled" } });
    expect((await call("admin", "POST", "/transfers/preview", { ...body, from: w.buyer, to: w.custodian })).json().error).toBe("sender_not_holder");
  });

  it("shows the index as the configured ownership source", async () => {
    expect((await call("manager", "GET", "/sync-status")).json().ownership).toEqual({ status: "configured", source: "chain_index" });
  });

  it("fails closed when the index contradicts itself", async () => {
    // A second, different event under an already recorded (signature, instruction).
    const first = (await readOwnershipIndex(pool, share))!.events[1]!;
    await withSystem(pool, (tx) => insertOwnershipEvents(tx, [{ ...first, amount: 1n }], "fixture"));
    const r = (await call("manager", "GET", `/assets/${shed}`)).json();
    expect(r.ownership[0]).toEqual({ representationId: shareRep, status: "not_indexed", reason: "reader_unavailable" });
    expect((await call("admin", "POST", "/transfers/preview", { representationId: shareRep, from: w.custodian, to: w.buyer, amount: "1" })).statusCode).not.toBe(200);
  });
});
