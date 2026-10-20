/**
 * Scheduled farm-state snapshots (digital twin). Off unless TWIN_SNAPSHOTS_ENABLED is set on the
 * worker and TWIN_SNAPSHOT_CRON on the scheduler.
 *
 * - The sweep fans out one job per farm with something to snapshot, keyed by farm and hour bucket.
 * - The farm job builds the canonical snapshot (packages/domain/src/twin/snapshot.ts) and compares
 *   its root with the newest recorded snapshot. Only a changed state is stored (content-addressed)
 *   and recorded as a data commitment, by the system rather than a person, and audited.
 *
 * Nothing here is written on-chain, signed or submitted.
 */
import {
  farmSnapshotEntities,
  farmsToSnapshot,
  getFarm,
  insertDataCommitment,
  listDataCommitments,
  withSystem,
  withTenant,
  writeAudit,
  type Pool,
} from "@metafarm/db";
import { QUEUES, SNAPSHOT_COMMITMENT_SCHEMA, buildFarmSnapshot, reconstructFarmSnapshot, serializeFarmSnapshot, type ContentStore, type FarmSnapshot, type TwinSnapshotJob } from "@metafarm/domain";
import type { Handler } from "../runner";
import type { Enqueue } from "./alerts";

export function twinSnapshotSweepHandler(pool: Pool, enqueue: Enqueue): Handler<{ bucket: string }> {
  return async (job, { log }) => {
    const farms = await withSystem(pool, (tx) => farmsToSnapshot(tx));
    for (const f of farms) await enqueue(QUEUES.twinSnapshots, { tenantId: f.tenant_id, farmId: f.farm_id, bucket: job.bucket });
    log.info({ farms: farms.length }, "twin snapshot sweep fanned out");
    return { farms: farms.length };
  };
}

export type TwinSnapshotOutcome =
  | { status: "recorded"; commitmentId: string; snapshotId: string; root: string; entityCount: number }
  | { status: "unchanged"; commitmentId: string; root: string }
  | { status: "skipped"; reason: "farm_missing" | "nothing_to_snapshot" | "too_large" };

export function twinSnapshotHandler(pool: Pool, contentStoreFor: (tenantId: string) => ContentStore, now: () => Date = () => new Date()): Handler<TwinSnapshotJob> {
  return async (job, { log }): Promise<TwinSnapshotOutcome> => {
    const read = await withTenant(pool, job.tenantId, async (tx) => {
      const farm = await getFarm(tx, job.farmId);
      if (!farm || farm.archived_at) return null;
      const latest = (await listDataCommitments(tx, { subjectType: "farm", subjectId: job.farmId, schema: SNAPSHOT_COMMITMENT_SCHEMA, limit: 1 }))[0];
      return { entities: await farmSnapshotEntities(tx, job.farmId), latest };
    });
    if (!read) return { status: "skipped", reason: "farm_missing" };
    if (read.entities.length === 0) return { status: "skipped", reason: "nothing_to_snapshot" };

    let snapshot: FarmSnapshot;
    try {
      snapshot = await buildFarmSnapshot({ farmId: job.farmId, takenAt: now(), entities: read.entities });
    } catch (err) {
      if (err instanceof RangeError) {
        log.warn({ farmId: job.farmId, reason: err.message }, "twin snapshot refused");
        return { status: "skipped", reason: "too_large" };
      }
      throw err;
    }

    const store = contentStoreFor(job.tenantId);
    if (read.latest) {
      // Unchanged state has the same root; a missing or damaged previous snapshot counts as changed.
      const bytes = await store.get(read.latest.content_sha256).catch(() => null);
      if (bytes) {
        const prev = await reconstructFarmSnapshot(new TextDecoder().decode(bytes)).catch(() => null);
        if (prev?.check.ok && prev.snapshot.root === snapshot.root) return { status: "unchanged", commitmentId: read.latest.id, root: snapshot.root };
      }
    }

    const stored = await store.put(new TextEncoder().encode(serializeFarmSnapshot(snapshot)), "application/json");
    const row = await withTenant(pool, job.tenantId, async (tx) => {
      const res = await insertDataCommitment(tx, {
        farmId: job.farmId,
        subjectType: "farm",
        subjectId: job.farmId,
        schema: SNAPSHOT_COMMITMENT_SCHEMA,
        schemaVersion: 1,
        contentSha256: stored.sha256,
        byteSize: stored.size,
        storageRef: stored.ref,
        sourceTime: new Date(snapshot.takenAt),
        attestationRef: null,
        recordedBy: null,
        clientRequestId: null,
      });
      if (res.created)
        await writeAudit(tx, {
          actorType: "job",
          action: "twin.snapshot.recorded",
          targetType: "data_commitment",
          targetId: res.row.id,
          metadata: { farmId: job.farmId, snapshotId: snapshot.snapshotId, root: snapshot.root, entityCount: snapshot.entityCount, bucket: job.bucket },
        });
      return res.row;
    });
    log.info({ farmId: job.farmId, entities: snapshot.entityCount }, "twin snapshot recorded");
    return { status: "recorded", commitmentId: row.id, snapshotId: snapshot.snapshotId, root: snapshot.root, entityCount: snapshot.entityCount };
  };
}
