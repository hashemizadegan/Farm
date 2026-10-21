/** Ownership index jobs: fan-out, windowed and idempotent ingestion, forward-only cursor, read-only app role. */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFarm, createPool, createTenantWithOwner, insertOwnershipEvents, migrateUp, readOwnershipIndex, upsertUserBySubject, withSystem, withTenant, type Pool } from "@metafarm/db";
import { QUEUES, type ChainAssetRef, type JobPayloads, type OwnershipEvent } from "@metafarm/domain";
import { IndexOwnershipReader, OwnershipIndexConflictError, base58Encode, createFixtureEventSource } from "@metafarm/chain";
import { createLogger } from "@metafarm/observability";
import { OwnershipSourceError, ownershipIndexHandler, ownershipIndexSweepHandler, type OwnershipIndexOutcome } from "./handlers/ownership-index";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const log = createLogger({ service: "test", level: "silent" });
const ctx = { log, attempt: 1, jobId: "t" };

// The index is global: this file uses its own random asset and wallets so parallel test files never meet.
const b58 = (n: number) => base58Encode(randomBytes(n));
const asset: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: b58(32) };
const wallets = { custodian: b58(32), investor: b58(32) };
const ev = (kind: OwnershipEvent["kind"], from: string | null, to: string | null, amount: bigint, slot: bigint, a: ChainAssetRef = asset): OwnershipEvent => ({
  asset: a, kind, from, to, amount, slot, txIndex: 0, ixIndex: 0, signature: b58(64),
});
const mint = ev("mint", null, wallets.custodian, 1_000_000n, 100n);
const transfer = ev("transfer", wallets.custodian, wallets.investor, 250_000n, 900n);
const job = { network: asset.network as "solana-devnet", rail: asset.rail as "SOLANA_TOKEN_2022", assetId: asset.id, bucket: "b" };

d("ownership index jobs", () => {
  let pool: Pool;
  let tenantId: string;
  const reader = () => new IndexOwnershipReader((a) => readOwnershipIndex(pool, a));

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
    const sfx = Math.random().toString(36).slice(2, 8);
    const userId = (await upsertUserBySubject(pool, { issuer: "test", subject: `oi-${sfx}` })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `oi-${sfx}`, name: "OI", ownerUserId: userId }));
    const farmId = (await withTenant(pool, tenantId, (tx) => createFarm(tx, { name: "F", timezone: "UTC", createdBy: userId }))).id;
    const assetRow = (await pool.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'building', 'Shed') RETURNING id`, [tenantId, farmId])).rows[0]!.id;
    await pool.query(
      `INSERT INTO asset_representations (tenant_id, asset_id, rail, network, status, mint_address, decimals) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'solana-devnet', 'active', $3, 6)`,
      [tenantId, assetRow, asset.id],
    );
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("fans out one job per Solana asset the platform has a chain identity for", async () => {
    const queued: JobPayloads[typeof QUEUES.ownershipIndex][] = [];
    const enqueue = async (q: string, p: unknown) => void (q === QUEUES.ownershipIndex && queued.push(p as JobPayloads[typeof QUEUES.ownershipIndex]));
    await ownershipIndexSweepHandler(pool, enqueue as never)({ bucket: "b" }, ctx);
    expect(queued).toContainEqual(job);
  });

  it("is not indexed until a job has run", async () => {
    expect(await readOwnershipIndex(pool, asset)).toBeNull();
    expect(await reader().holdersOf(asset)).toBeNull();
  });

  it("stores the finalized events and moves the cursor; ownership is as of that slot", async () => {
    const source = createFixtureEventSource([mint, transfer], 500n);
    const r = (await ownershipIndexHandler(pool, source)(job, ctx)) as OwnershipIndexOutcome;
    expect(r).toEqual({ status: "indexed", inserted: 1, indexedThroughSlot: "500" });
    expect(await reader().holdersOf(asset)).toEqual({ holders: [{ owner: wallets.custodian, amount: 1_000_000n }], asOfSlot: 500n, assurance: "indexer_reported" });

    source.finalize(1_000n);
    expect(await ownershipIndexHandler(pool, source)(job, ctx)).toEqual({ status: "indexed", inserted: 1, indexedThroughSlot: "1000" });
    const holders = (await reader().holdersOf(asset))!;
    expect(holders.asOfSlot).toBe(1_000n);
    expect(holders.holders).toEqual(
      [
        { owner: wallets.custodian, amount: 750_000n },
        { owner: wallets.investor, amount: 250_000n },
      ].sort((a, b) => (a.owner < b.owner ? -1 : 1)),
    );
  });

  it("records a replayed event once and never moves the cursor back", async () => {
    expect(await withSystem(pool, (tx) => insertOwnershipEvents(tx, [mint, transfer], "fixture"))).toBe(0);
    const behind = createFixtureEventSource([mint], 400n);
    expect(await ownershipIndexHandler(pool, behind)(job, ctx)).toEqual({ status: "skipped", reason: "source_behind_cursor" });
    expect((await readOwnershipIndex(pool, asset))!.indexedThroughSlot).toBe(1_000n);
  });

  it("refuses events of another asset or outside the window, storing nothing", async () => {
    const other: ChainAssetRef = { ...asset, id: b58(32) };
    const wrongAsset = { name: "fixture" as const, covers: () => true, eventsAfter: async () => ({ events: [ev("mint", null, wallets.custodian, 1n, 1_100n, other)], throughSlot: 1_200n }) };
    await expect(ownershipIndexHandler(pool, wrongAsset)(job, ctx)).rejects.toBeInstanceOf(OwnershipSourceError);
    const outside = { name: "fixture" as const, covers: () => true, eventsAfter: async () => ({ events: [ev("burn", wallets.investor, null, 1n, 1_500n)], throughSlot: 1_200n }) };
    await expect(ownershipIndexHandler(pool, outside)(job, ctx)).rejects.toBeInstanceOf(OwnershipSourceError);
    expect((await readOwnershipIndex(pool, asset))!.indexedThroughSlot).toBe(1_000n);
    expect((await readOwnershipIndex(pool, asset))!.events).toHaveLength(2);
  });

  it("fails closed when two different events claim the same instruction", async () => {
    const forged: OwnershipEvent = { ...transfer, amount: 999n };
    expect(await withSystem(pool, (tx) => insertOwnershipEvents(tx, [forged], "fixture"))).toBe(1);
    await expect(reader().holdersOf(asset)).rejects.toBeInstanceOf(OwnershipIndexConflictError);
  });

  it("lets the application role read the index but never write it", async () => {
    await expect(
      withTenant(pool, tenantId, (tx) =>
        tx.query(`INSERT INTO chain_ownership_cursors (network, rail, asset_id, indexed_through_slot, source) VALUES ('solana-devnet', 'SOLANA_TOKEN_2022', $1, 1, 'fixture')`, [b58(32)]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(pool, tenantId, (tx) => tx.query(`UPDATE chain_ownership_cursors SET indexed_through_slot = 0 WHERE asset_id = $1`, [asset.id]))).rejects.toMatchObject({ code: "42501" });
    expect((await withTenant(pool, tenantId, (tx) => tx.query(`SELECT count(*)::int AS n FROM chain_ownership_events WHERE asset_id = $1`, [asset.id]))).rows[0].n).toBe(3);
  });
});
