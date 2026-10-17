/**
 * Job integration tests against PostgreSQL + PostGIS (DATABASE_URL).
 * Covers GIS validation, observation normalisation idempotency, alert
 * de-duplication, job-run idempotency and chain-indexer reorg handling.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimJobRun,
  completeJobRun,
  createFarm,
  createPool,
  createTenantWithOwner,
  getFarm,
  insertBoundaryVersion,
  insertRawObservation,
  migrateUp,
  upsertUserBySubject,
  withSystem,
  withTenant,
  type Pool,
} from "@metafarm/db";
import { createLogger } from "@metafarm/observability";
import { alertEvaluationHandler } from "./handlers/alerts";
import { chainIndexHandler, type ChainReader } from "./handlers/chain";
import { gisValidationHandler } from "./handlers/gis";
import { observationNormalizationHandler } from "./handlers/observations";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const log = createLogger({ service: "test", level: "silent" });
const ctx = { log, attempt: 1, jobId: "t" };

d("worker jobs", () => {
  let pool: Pool;
  let tenantId: string;
  let farmId: string;
  let userId: string;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
    const sfx = Math.random().toString(36).slice(2, 8);
    userId = (await upsertUserBySubject(pool, { issuer: "test", subject: `w-${sfx}` })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `w-${sfx}`, name: "W", ownerUserId: userId }));
    farmId = (await withTenant(pool, tenantId, (tx) => createFarm(tx, { name: "F", timezone: "UTC", createdBy: userId }))).id;
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("validates a boundary in PostGIS and makes it current", async () => {
    const b = await withTenant(pool, tenantId, (tx) =>
      insertBoundaryVersion(tx, {
        farmId,
        geometry: { type: "Polygon", coordinates: [[[20, 1], [20.001, 1], [20.001, 1.001], [20, 1.001], [20, 1]]] },
        source: "drawn",
        geometryHash: `h-${Math.random()}`,
        areaM2: 12_000,
        vertexCount: 5,
        submittedBy: userId,
      }),
    );
    const r = (await gisValidationHandler(pool)({ tenantId, farmId, boundaryVersionId: b.id }, ctx)) as { status: string };
    expect(r.status).toBe("valid");
    const farm = await withTenant(pool, tenantId, async (tx) => (await tx.query(`SELECT current_boundary_version_id FROM farms WHERE id = $1`, [farmId])).rows[0]);
    expect(farm.current_boundary_version_id).toBe(b.id);
    // The farm now carries a drawable outline of that boundary: a closed ring of [lon, lat] pairs.
    const withOutline = await withTenant(pool, tenantId, (tx) => getFarm(tx, farmId));
    expect(withOutline!.outline!.length).toBeGreaterThanOrEqual(4);
    expect(withOutline!.outline![0]).toEqual(withOutline!.outline!.at(-1));
    expect(withOutline!.boundary_area_m2).toBeGreaterThan(0);
    // Running again is a no-op.
    expect(((await gisValidationHandler(pool)({ tenantId, farmId, boundaryVersionId: b.id }, ctx)) as { status: string }).status).toBe("valid");
  });

  it("normalises an observation exactly once", async () => {
    const raw = await withTenant(pool, tenantId, (tx) =>
      insertRawObservation(tx, {
        farmId,
        payload: { metric: "soil_moisture", value: 0.12, unit: "fraction_vwc", observedAt: new Date().toISOString() },
        provenance: "user-entered",
        userId,
      }),
    );
    const h = observationNormalizationHandler(pool);
    const a = (await h({ tenantId, farmId, rawObservationId: raw.id }, ctx)) as { observationId: string; inserted: boolean };
    const b = (await h({ tenantId, farmId, rawObservationId: raw.id }, ctx)) as { observationId: string; inserted: boolean };
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.observationId).toBe(a.observationId);
    const row = await withTenant(pool, tenantId, async (tx) => (await tx.query(`SELECT value, unit, provenance_label FROM observations WHERE id = $1`, [a.observationId])).rows[0]);
    expect(row).toEqual({ value: 12, unit: "percent_vwc", provenance_label: "user-entered" });
  });

  it("rejects unknown units instead of guessing", async () => {
    const raw = await withTenant(pool, tenantId, (tx) =>
      insertRawObservation(tx, { farmId, payload: { metric: "rainfall", value: 3, unit: "buckets", observedAt: new Date().toISOString() }, provenance: "user-entered" }),
    );
    const r = (await observationNormalizationHandler(pool)({ tenantId, farmId, rawObservationId: raw.id }, ctx)) as { status: string };
    expect(r.status).toBe("rejected");
  });

  it("raises an alert once per evidence set", async () => {
    await withTenant(pool, tenantId, (tx) =>
      tx.query(
        `INSERT INTO alert_rules (tenant_id, farm_id, metric, comparator, threshold, consecutive, severity) VALUES ($1, $2, 'soil_moisture', 'lt', 20, 1, 'warning')`,
        [tenantId, farmId],
      ),
    );
    const h = alertEvaluationHandler(pool);
    const first = (await h({ tenantId, farmId, bucket: "b1" }, ctx)) as { created: number };
    const second = (await h({ tenantId, farmId, bucket: "b2" }, ctx)) as { created: number };
    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
  });

  it("records job completion so duplicates are skipped", async () => {
    const key = `test:${Math.random()}`;
    expect(await claimJobRun(pool, key, "q")).toBe("claimed");
    await completeJobRun(pool, key, { ok: true });
    expect(await claimJobRun(pool, key, "q")).toBe("completed");
  });

  it("indexes chain events idempotently and rewinds on reorg", async () => {
    const contract = `0x${Math.random().toString(16).slice(2).padEnd(40, "0").slice(0, 40)}`;
    const hashes = new Map<bigint, string>();
    for (let i = 0n; i <= 120n; i++) hashes.set(i, `0xa${i}`);
    let logs = [{ blockNumber: 50n, blockHash: "0xa50", txHash: "0xt1", logIndex: 0, eventName: "Transfer", args: { tokenId: 1n } }];
    const reader: ChainReader = {
      latestBlock: async () => 120n,
      blockHash: async (n) => hashes.get(n),
      getLogs: async (_c, from, to) => logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to),
    };
    const h = chainIndexHandler(pool, reader, { chainId: 31337, confirmations: 12, maxRange: 1000n, reorgRewind: 64n });
    const job = { chainId: 31337, contractAddress: contract, fromBlock: "0", toBlock: "latest:1" };
    const r1 = (await h(job, ctx)) as { indexed: number; to: string };
    expect(r1.indexed).toBe(1);
    expect(r1.to).toBe("108");
    // Re-running does not duplicate.
    await h(job, ctx);
    const count = async () => Number((await pool.query(`SELECT count(*) FROM chain_events WHERE contract_address = $1 AND NOT removed`, [contract])).rows[0].count);
    expect(await count()).toBe(1);

    // Simulate a reorg: block 108 now has a different hash and the event moved.
    hashes.set(108n, "0xreorg");
    logs = [{ blockNumber: 51n, blockHash: "0xb51", txHash: "0xt1", logIndex: 0, eventName: "Transfer", args: { tokenId: 1n } }];
    await h({ ...job, toBlock: "latest:2" }, ctx);
    const row = (await pool.query(`SELECT block_number, removed FROM chain_events WHERE contract_address = $1`, [contract])).rows[0];
    expect(row).toEqual({ block_number: "51", removed: false });
  });
});
