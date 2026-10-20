/**
 * Farm-state snapshots for client sync. Building one reads the farm's entities, serialises them as
 * a canonical snapshot (packages/domain/src/twin/snapshot.ts), stores the bytes content-addressed,
 * and records a data commitment to them. A client keeps the snapshotId it has, asks for the latest
 * commitment, and fetches and verifies a new snapshot only when it changed.
 *
 * Read and verify only: nothing here is anchored on-chain, signed or submitted.
 */
import type { FastifyInstance } from "fastify";
import { farmSnapshotEntities, findDataCommitmentByRequest, getDataCommitment, getFarm, insertDataCommitment, listDataCommitments } from "@metafarm/db";
import { ContentIntegrityError, buildFarmSnapshot, reconstructFarmSnapshot, serializeFarmSnapshot, SNAPSHOT_COMMITMENT_SCHEMA, type FarmSnapshot } from "@metafarm/domain";
import { z } from "zod";
import { HttpError, idempotencyKey, keyReused, notFound, parse } from "../lib/http";
import { createObjectContentStore } from "../storage/content-store";
import { toCommitment } from "./twin";

const SNAPSHOT_MEDIA_TYPE = "application/json";

const farmParams = z.object({ tenantId: z.string().uuid(), farmId: z.string().uuid() });
const snapshotParams = z.object({ tenantId: z.string().uuid(), commitmentId: z.string().uuid() });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(10), cursor: z.string().uuid().optional() }).strict();

export async function twinSnapshotRoutes(app: FastifyInstance) {
  app.post("/v1/tenants/:tenantId/twin/farms/:farmId/snapshots", async (req, reply) => {
    const { tenantId, farmId } = parse(farmParams, req.params);
    if (req.body !== undefined && req.body !== null && (typeof req.body !== "object" || Object.keys(req.body as object).length > 0))
      throw new HttpError(400, "invalid_request", "this request takes no body");
    const key = idempotencyKey(req);

    // Read the farm in one transaction; build and store outside it.
    const read = await app.inTenant(req, "rwa:operate", async (tx) => {
      if (key) {
        const seen = await findDataCommitmentByRequest(tx, key);
        if (seen) {
          if (seen.subject_type !== "farm" || seen.subject_id !== farmId || seen.data_schema !== SNAPSHOT_COMMITMENT_SCHEMA || seen.recorded_by !== req.user!.id) throw keyReused();
          return { replay: seen };
        }
      }
      const farm = await getFarm(tx, farmId);
      if (!farm) throw notFound("farm");
      return { entities: await farmSnapshotEntities(tx, farmId) };
    });
    if ("replay" in read) return reply.status(200).send(await summary(tenantId, read.replay));
    if (read.entities.length === 0) throw new HttpError(409, "nothing_to_snapshot", "the farm has no assets, machines, seasons or stock yet");

    const takenAt = app.deps.now();
    let snapshot: FarmSnapshot;
    try {
      snapshot = await buildFarmSnapshot({ farmId, takenAt, entities: read.entities });
    } catch (err) {
      if (err instanceof RangeError) throw new HttpError(422, "snapshot_refused", err.message);
      throw err;
    }
    const bytes = new TextEncoder().encode(serializeFarmSnapshot(snapshot));
    // Content-addressed: storing before the commitment is safe; an unreferenced object is harmless.
    const stored = await createObjectContentStore(app.deps.storage, tenantId).put(bytes, SNAPSHOT_MEDIA_TYPE);

    const row = await app.inTenant(req, "rwa:operate", async (tx) => {
      const res = await insertDataCommitment(tx, {
        farmId,
        subjectType: "farm",
        subjectId: farmId,
        schema: SNAPSHOT_COMMITMENT_SCHEMA,
        schemaVersion: 1,
        contentSha256: stored.sha256,
        byteSize: stored.size,
        storageRef: stored.ref,
        sourceTime: takenAt,
        attestationRef: null,
        recordedBy: req.user!.id,
        clientRequestId: key ?? null,
      });
      if (res.created)
        await app.audit(req, tx, {
          action: "twin.snapshot.recorded",
          targetType: "data_commitment",
          targetId: res.row.id,
          metadata: { farmId, snapshotId: snapshot.snapshotId, root: snapshot.root, entityCount: snapshot.entityCount, contentSha256: stored.sha256 },
        });
      return res.row;
    });
    return reply.status(201).send({ ...toCommitment(row), snapshotId: snapshot.snapshotId, root: snapshot.root, entityCount: snapshot.entityCount, takenAt: snapshot.takenAt });
  });

  app.get("/v1/tenants/:tenantId/twin/farms/:farmId/snapshots", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    const q = parse(listQuery, req.query);
    return app.inTenant(req, "rwa:read", async (tx) => {
      if (!(await getFarm(tx, farmId))) throw notFound("farm");
      const rows = await listDataCommitments(tx, { subjectType: "farm", subjectId: farmId, schema: SNAPSHOT_COMMITMENT_SCHEMA, limit: q.limit + 1, before: q.cursor });
      const page = rows.slice(0, q.limit);
      return { items: page.map(toCommitment), nextCursor: rows.length > q.limit ? page.at(-1)!.id : null };
    });
  });

  app.get("/v1/tenants/:tenantId/twin/snapshots/:commitmentId", async (req, reply) => {
    const { tenantId, commitmentId } = parse(snapshotParams, req.params);
    const c = await app.inTenant(req, "rwa:read", (tx) => getDataCommitment(tx, commitmentId));
    if (!c || c.data_schema !== SNAPSHOT_COMMITMENT_SCHEMA) throw notFound("snapshot");
    let bytes: Uint8Array | null;
    try {
      bytes = await createObjectContentStore(app.deps.storage, tenantId).get(c.content_sha256);
    } catch (err) {
      if (err instanceof ContentIntegrityError) throw new HttpError(409, "content_integrity_failed", "the stored snapshot no longer matches its hash");
      throw err;
    }
    if (!bytes) throw new HttpError(404, "snapshot_content_missing", "the snapshot's bytes are not in storage");
    const { snapshot, check } = await reconstructFarmSnapshot(new TextDecoder().decode(bytes));
    reply.header("etag", `"${snapshot.snapshotId}"`);
    return { commitment: toCommitment(c), check, snapshot };
  });

  /** For an idempotent replay: the snapshot's header, read back from storage. */
  async function summary(tenantId: string, row: Parameters<typeof toCommitment>[0]) {
    const bytes = await createObjectContentStore(app.deps.storage, tenantId).get(row.content_sha256);
    const s = bytes ? (await reconstructFarmSnapshot(new TextDecoder().decode(bytes))).snapshot : null;
    return { ...toCommitment(row), snapshotId: s?.snapshotId ?? null, root: s?.root ?? null, entityCount: s?.entityCount ?? null, takenAt: s?.takenAt ?? null };
  }
}

