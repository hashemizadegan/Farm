/** Scheduled Merkle batches of snapshot commitments: per workspace, across farms, system-attributed, data only. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFarm, createPool, createTenantWithOwner, insertDataCommitment, migrateUp, upsertUserBySubject, withSystem, withTenant, type Pool } from "@metafarm/db";
import { QUEUES, SNAPSHOT_COMMITMENT_SCHEMA, merkleLeaf, merkleRoot, planAnchor, type JobPayloads } from "@metafarm/domain";
import { createLogger } from "@metafarm/observability";
import { snapshotBatchDataset, twinSnapshotBatchHandler, twinSnapshotBatchSweepHandler, type TwinSnapshotBatchOutcome } from "./handlers/twin-snapshot-batches";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const log = createLogger({ service: "test", level: "silent" });
const ctx = { log, attempt: 1, jobId: "t" };
const BUCKET = "2026-10-21T03:00:00.000Z";

describe("snapshotBatchDataset", () => {
  it("names the batch by hour and keeps the Token-2022 anchor key within 32 bytes", () => {
    expect(snapshotBatchDataset(BUCKET)).toBe("snapshots/2026102103");
    const plan = planAnchor({ carrier: "token2022_metadata", network: "solana-devnet", subject: "batch", root: "a".repeat(64), label: snapshotBatchDataset(BUCKET), mainnetEnabled: false });
    expect(plan).toMatchObject({ metadataField: { key: "mf:batch:snapshots/2026102103" }, executable: false });
    expect(() => snapshotBatchDataset("not a time")).toThrow(RangeError);
  });
});

d("twin snapshot batch jobs", () => {
  let pool: Pool;
  let tenantId: string;
  let farmA: string;
  let farmB: string;
  let n = 0;
  const hash = () => (++n).toString(16).padStart(64, "0");
  const commit = (farmId: string, schema = SNAPSHOT_COMMITMENT_SCHEMA) =>
    withTenant(pool, tenantId, async (tx) =>
      (
        await insertDataCommitment(tx, {
          farmId,
          subjectType: "farm",
          subjectId: farmId,
          schema,
          schemaVersion: 1,
          contentSha256: hash(),
          byteSize: 10,
          storageRef: null,
          sourceTime: new Date("2026-10-21T02:00:00Z"),
          attestationRef: null,
          recordedBy: null,
          clientRequestId: null,
        })
      ).row,
    );
  const run = (maxLeaves?: number) => twinSnapshotBatchHandler(pool, maxLeaves)({ tenantId, bucket: BUCKET }, ctx) as Promise<TwinSnapshotBatchOutcome>;
  const sweep = async () => {
    const queued: JobPayloads[typeof QUEUES.twinSnapshotBatches][] = [];
    const enqueue = async (q: string, p: unknown) => void (q === QUEUES.twinSnapshotBatches && queued.push(p as JobPayloads[typeof QUEUES.twinSnapshotBatches]));
    await twinSnapshotBatchSweepHandler(pool, enqueue as never)({ bucket: BUCKET }, ctx);
    return queued.filter((j) => j.tenantId === tenantId);
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
    const sfx = Math.random().toString(36).slice(2, 8);
    const userId = (await upsertUserBySubject(pool, { issuer: "test", subject: `twb-${sfx}` })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `twb-${sfx}`, name: "TWB", ownerUserId: userId }));
    farmA = (await withTenant(pool, tenantId, (tx) => createFarm(tx, { name: "A", timezone: "UTC", createdBy: userId }))).id;
    farmB = (await withTenant(pool, tenantId, (tx) => createFarm(tx, { name: "B", timezone: "UTC", createdBy: userId }))).id;
  });
  afterAll(async () => {
    await pool?.end();
  });

  let snaps: { id: string; content_sha256: string }[];
  let survey: { id: string };

  it("fans out one job per workspace with snapshot commitments in no batch", async () => {
    expect(await sweep()).toEqual([]);
    snaps = [await commit(farmA), await commit(farmB), await commit(farmA)];
    survey = await commit(farmA, "metafarm.survey");
    expect(await sweep()).toEqual([{ tenantId, bucket: BUCKET }]);
  });

  it("fixes every farm's snapshots into one RFC 9162 batch, attributed to the system and audited", async () => {
    const r = await run();
    expect(r.status).toBe("batched");
    if (r.status !== "batched") return;
    const expectedRoot = await merkleRoot(await Promise.all(snaps.map((s) => merkleLeaf(s.content_sha256))));
    expect(r).toMatchObject({ dataset: "snapshots/2026102103", root: expectedRoot, leafCount: 3, farmCount: 2, remaining: false });
    const batch = (await pool.query(`SELECT created_by, scheme, merkle_root, leaf_count FROM commitment_batches WHERE id = $1`, [r.batchId])).rows[0];
    expect(batch).toEqual({ created_by: null, scheme: "metafarm-merkle-sha256/1", merkle_root: expectedRoot, leaf_count: 3 });
    const leaves = (await pool.query(`SELECT commitment_id FROM commitment_batch_leaves WHERE batch_id = $1 ORDER BY leaf_index`, [r.batchId])).rows.map((x) => x.commitment_id);
    expect(leaves).toEqual(snaps.map((s) => s.id));
    const audit = (await pool.query(`SELECT actor_type, actor_user_id, action FROM audit_events WHERE tenant_id = $1 AND target_id = $2`, [tenantId, r.batchId])).rows;
    expect(audit).toEqual([{ actor_type: "job", actor_user_id: null, action: "twin.snapshot.batched" }]);
  });

  it("leaves other schemas alone and has nothing left to do afterwards", async () => {
    expect((await pool.query(`SELECT 1 FROM commitment_batch_leaves WHERE commitment_id = $1`, [survey.id])).rowCount).toBe(0);
    expect(await run()).toEqual({ status: "skipped", reason: "nothing_to_batch" });
    expect(await sweep()).toEqual([]);
  });

  it("caps a batch and says when a later run has work left", async () => {
    const more = [await commit(farmB), await commit(farmA)];
    const first = await run(1);
    expect(first).toMatchObject({ status: "batched", leafCount: 1, remaining: true });
    const second = await run(1);
    expect(second).toMatchObject({ status: "batched", leafCount: 1, remaining: false });
    const batchedIds = (await pool.query(`SELECT commitment_id FROM commitment_batch_leaves WHERE commitment_id = ANY($1::uuid[])`, [more.map((m) => m.id)])).rows;
    expect(batchedIds).toHaveLength(2);
    expect(() => twinSnapshotBatchHandler(pool, 0)).toThrow(RangeError);
  });
});
