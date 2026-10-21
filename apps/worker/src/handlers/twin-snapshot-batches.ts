/**
 * Scheduled Merkle batches of farm-snapshot commitments (digital twin). Off unless
 * TWIN_SNAPSHOT_BATCHES_ENABLED is set on the worker and TWIN_SNAPSHOT_BATCH_CRON on the scheduler.
 *
 * - The sweep finds the workspaces that have snapshot commitments in no batch yet and enqueues one
 *   job per workspace, keyed by workspace and hour bucket.
 * - The workspace job takes up to MAX_BATCH_LEAVES of those commitments, oldest first, across all
 *   of the workspace's farms, and fixes them into one RFC 9162 batch: leaf = SHA-256(0x00 ‖ content
 *   hash), the same scheme as POST …/data-commitments/batches, so the existing proof endpoint and
 *   anchor plans work unchanged. Attributed to the system and audited.
 *
 * Batches are per workspace: commitments live under row-level security, and one root spanning
 * several workspaces would let a proof reveal another workspace's leaf hashes.
 *
 * Data only: nothing here is anchored, signed, submitted or written on-chain.
 */
import { tenantsWithUnbatchedCommitments, unbatchedDataCommitments, insertCommitmentBatch, withSystem, withTenant, writeAudit, type Pool } from "@metafarm/db";
import { MAX_BATCH_LEAVES, MERKLE_SCHEME, QUEUES, SNAPSHOT_COMMITMENT_SCHEMA, merkleLeaf, merkleRoot, type TwinSnapshotBatchJob } from "@metafarm/domain";
import type { Handler } from "../runner";
import type { Enqueue } from "./alerts";

/** `snapshots/YYYYMMDDHH` from an ISO bucket: short enough for a Token-2022 anchor key (`mf:batch:` + 20 ≤ 32 bytes). */
export function snapshotBatchDataset(bucket: string): string {
  const d = new Date(bucket);
  if (Number.isNaN(d.getTime())) throw new RangeError(`bucket ${bucket} is not a time`);
  return `snapshots/${d.toISOString().slice(0, 13).replace(/[-T]/g, "")}`;
}

export function twinSnapshotBatchSweepHandler(pool: Pool, enqueue: Enqueue): Handler<{ bucket: string }> {
  return async (job, { log }) => {
    const tenants = await withSystem(pool, (tx) => tenantsWithUnbatchedCommitments(tx, SNAPSHOT_COMMITMENT_SCHEMA));
    for (const tenantId of tenants) await enqueue(QUEUES.twinSnapshotBatches, { tenantId, bucket: job.bucket });
    log.info({ tenants: tenants.length }, "twin snapshot batch sweep fanned out");
    return { tenants: tenants.length };
  };
}

export type TwinSnapshotBatchOutcome =
  | { status: "batched"; batchId: string; dataset: string; root: string; leafCount: number; farmCount: number; remaining: boolean }
  | { status: "skipped"; reason: "nothing_to_batch" | "raced" };

export function twinSnapshotBatchHandler(pool: Pool, maxLeaves: number = MAX_BATCH_LEAVES): Handler<TwinSnapshotBatchJob> {
  if (!Number.isInteger(maxLeaves) || maxLeaves < 1 || maxLeaves > MAX_BATCH_LEAVES) throw new RangeError(`maxLeaves must be 1..${MAX_BATCH_LEAVES}`);
  return async (job, { log }): Promise<TwinSnapshotBatchOutcome> => {
    const dataset = snapshotBatchDataset(job.bucket);
    return withTenant(pool, job.tenantId, async (tx) => {
      // One more than fits tells whether a later run has work left.
      const rows = await unbatchedDataCommitments(tx, SNAPSHOT_COMMITMENT_SCHEMA, maxLeaves + 1);
      if (rows.length === 0) return { status: "skipped", reason: "nothing_to_batch" } as const;
      const taken = rows.slice(0, maxLeaves);
      const leaves = await Promise.all(taken.map((r) => merkleLeaf(r.content_sha256)));
      const root = await merkleRoot(leaves);
      let batchId: string;
      try {
        await tx.query("SAVEPOINT twin_snapshot_batch");
        batchId = (
          await insertCommitmentBatch(tx, {
            dataset,
            scheme: MERKLE_SCHEME,
            merkleRoot: root,
            leaves: taken.map((r, i) => ({ commitmentId: r.id, leafHash: leaves[i]! })),
            createdBy: null,
            clientRequestId: null,
          })
        ).id;
      } catch (err) {
        // Another batch (a person's, or a concurrent job) took one of these commitments first.
        if ((err as { code?: string }).code === "23505") {
          await tx.query("ROLLBACK TO SAVEPOINT twin_snapshot_batch");
          log.info({ tenantId: job.tenantId }, "twin snapshot batch raced; the next run picks up what is left");
          return { status: "skipped", reason: "raced" } as const;
        }
        throw err;
      }
      const farmCount = new Set(taken.map((r) => r.farm_id)).size;
      await writeAudit(tx, {
        actorType: "job",
        action: "twin.snapshot.batched",
        targetType: "commitment_batch",
        targetId: batchId,
        metadata: { dataset, merkleRoot: root, leafCount: taken.length, farmCount, bucket: job.bucket },
      });
      log.info({ tenantId: job.tenantId, leaves: taken.length, farms: farmCount }, "twin snapshot batch fixed");
      return { status: "batched", batchId, dataset, root, leafCount: taken.length, farmCount, remaining: rows.length > maxLeaves } as const;
    });
  };
}
