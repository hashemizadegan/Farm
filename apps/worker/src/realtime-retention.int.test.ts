/**
 * Realtime outbox retention against a real database: only rows past expires_at are deleted; each workspace's horizon
 * becomes the highest cursor deleted; runs are bounded (batches) and safe to repeat or overlap.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, withTenant, appendRealtimeEvent, type Pool } from "@metafarm/db";
import { createLogger } from "@metafarm/observability";
import { pruneRealtimeOutbox, realtimeRetentionHandler } from "./handlers/realtime-retention";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("realtime outbox retention", () => {
  let pool: Pool;
  const sfx = Math.random().toString(36).slice(2, 8);
  let tenantA: string;
  let tenantB: string;

  const event = (tenantId: string) => ({
    scheme: "metafarm-event/1",
    type: "yield.cycle.updated",
    schemaVersion: 1,
    id: randomUUID(),
    scope: { tenantId, farmId: null },
    occurredAt: new Date().toISOString(),
    correlationId: null,
    payload: { cycleId: randomUUID(), status: "draft", simulation: true },
  });
  /** An already expired row (written as the owner: rows are immutable, so expiry is set at insert). */
  const expired = async (tenantId: string) =>
    (
      await pool.query<{ seq: string }>(
        `INSERT INTO realtime_events (id, tenant_id, farm_id, type, schema_version, payload, occurred_at, created_at, expires_at)
         VALUES ($1, $2, NULL, 'yield.cycle.updated', 1, $3::jsonb, now() - interval '10 days', now() - interval '10 days', now() - interval '1 day')
         RETURNING seq::text`,
        [randomUUID(), tenantId, JSON.stringify({ cycleId: randomUUID(), status: "draft", simulation: true })],
      )
    ).rows[0]!.seq;
  const retained = (tenantId: string) => withTenant(pool, tenantId, (tx) => appendRealtimeEvent(tx, event(tenantId)));
  const count = async (tenantId: string) => Number((await pool.query(`SELECT count(*) FROM realtime_events WHERE tenant_id = $1`, [tenantId])).rows[0].count);
  const horizon = async (tenantId: string) => (await pool.query<{ s: string }>(`SELECT pruned_through_seq::text AS s FROM realtime_retention_horizons WHERE tenant_id = $1`, [tenantId])).rows[0]?.s ?? null;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 6 });
    await migrateUp(pool);
    const owner = (await upsertUserBySubject(pool, { issuer: "dev", subject: `rr-${sfx}` })).id;
    tenantA = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `rr-a-${sfx}`, name: "RR A", ownerUserId: owner }));
    tenantB = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `rr-b-${sfx}`, name: "RR B", ownerUserId: owner }));
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("deletes expired rows only and records each workspace's horizon; a repeat run changes nothing", async () => {
    const a1 = await expired(tenantA);
    await retained(tenantA);
    const a2 = await expired(tenantA);
    const b1 = await expired(tenantB);
    await retained(tenantB);
    const first = await pruneRealtimeOutbox(pool, { batchSize: 100, maxBatches: 5, maxMs: 30_000 });
    expect(first).toMatchObject({ deleted: 3, batches: 1, complete: true });
    expect([await count(tenantA), await count(tenantB)]).toEqual([1, 1]);
    expect([await horizon(tenantA), await horizon(tenantB)]).toEqual([a2, b1]);
    expect(BigInt(a2)).toBeGreaterThan(BigInt(a1));

    const again = await pruneRealtimeOutbox(pool, { batchSize: 100, maxBatches: 5, maxMs: 30_000 });
    expect(again).toMatchObject({ deleted: 0, complete: true });
    expect([await count(tenantA), await horizon(tenantA)]).toEqual([1, a2]);
  });

  it("stops at its batch budget, leaving the rest for the next run; the horizon only moves forward", async () => {
    const seqs: string[] = [];
    for (let i = 0; i < 5; i++) seqs.push(await expired(tenantA));
    const bounded = await pruneRealtimeOutbox(pool, { batchSize: 2, maxBatches: 1, maxMs: 30_000 });
    expect(bounded).toMatchObject({ deleted: 2, batches: 1, complete: false });
    expect(await horizon(tenantA)).toBe(seqs[1]);
    const rest = await pruneRealtimeOutbox(pool, { batchSize: 2, maxBatches: 10, maxMs: 30_000 });
    expect(rest).toMatchObject({ deleted: 3, complete: true });
    expect(await horizon(tenantA)).toBe(seqs[4]);
  });

  it("overlapping runs never delete twice or block each other", async () => {
    for (let i = 0; i < 40; i++) await expired(i % 2 ? tenantA : tenantB);
    const runs = await Promise.all([1, 2, 3].map(() => pruneRealtimeOutbox(pool, { batchSize: 5, maxBatches: 20, maxMs: 30_000 })));
    expect(runs.reduce((n, r) => n + r.deleted, 0)).toBe(40);
    expect((await pool.query(`SELECT count(*) FROM realtime_events WHERE expires_at <= now()`)).rows[0].count).toBe("0");
  });

  it("the scheduled handler reports counts", async () => {
    await expired(tenantB);
    const log = createLogger({ service: "test", level: "silent" });
    const out = await realtimeRetentionHandler(pool, { batchSize: 100, maxBatches: 2, maxMs: 30_000 })({ bucket: new Date().toISOString() }, { log, attempt: 1, jobId: "t" });
    expect(out).toMatchObject({ deleted: 1, complete: true });
  });
});
