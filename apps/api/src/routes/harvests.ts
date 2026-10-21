import type { FastifyInstance } from "fastify";
import {
  getFarm,
  getHarvest,
  findActiveSeason,
  findHarvestByRequest,
  getHarvestByCode,
  getSeason,
  getTask,
  insertHarvest,
  listHarvests,
  restartAnchoring,
  tenantName,
  voidHarvest,
  withSystem,
  type HarvestRow,
} from "@metafarm/db";
import {
  HARVEST_CODE,
  QUEUES,
  buildHarvestRecord,
  createHarvestSchema,
  harvestChainId,
  harvestCode,
  harvestRecordHash,
  uuid,
  voidHarvestSchema,
  type AnchorStatus,
} from "@metafarm/domain";
import { z } from "zod";
import { HttpError, idempotencyKey, keyReused, notFound, parse } from "../lib/http";

const farmParams = z.object({ tenantId: uuid, farmId: uuid });
const batchParams = farmParams.extend({ batchId: uuid });

const anchorInfo = (h: HarvestRow, explorer?: string, chainName?: string) => ({
  status: h.anchor_status,
  chainId: h.anchor_chain_id,
  chainName: chainName ?? null,
  contract: h.anchor_contract,
  txHash: h.anchor_tx_hash,
  block: h.anchor_block,
  anchoredAt: h.anchored_at ? new Date(h.anchored_at).toISOString() : null,
  explorerUrl: h.anchor_tx_hash && explorer ? `${explorer}${h.anchor_tx_hash}` : null,
});

export async function harvestRoutes(app: FastifyInstance) {
  const { env } = app.deps;
  const anchoringConfigured = () => Boolean(env.HARVEST_REGISTRY_ADDRESS && env.CHAIN_RPC_URL);

  const toHarvest = (h: HarvestRow) => ({
    id: h.id,
    farmId: h.farm_id,
    code: h.code,
    cropName: h.crop_name,
    parcelLabel: h.parcel_label,
    harvestedOn: h.harvested_on,
    quantity: h.public_record.quantity,
    unit: h.unit,
    qualityGrade: h.quality_grade,
    notes: h.notes,
    taskId: h.task_id,
    seasonId: h.season_id,
    publicRecord: h.public_record,
    recordHash: h.record_hash,
    anchor: { ...anchorInfo(h, env.CHAIN_EXPLORER_TX_URL, env.CHAIN_NAME), error: h.anchor_error },
    voidedAt: h.voided_at ? new Date(h.voided_at).toISOString() : null,
    voidReason: h.void_reason,
    voidAnchorStatus: h.void_anchor_status,
    recordedByName: h.recorded_by_name,
    createdAt: new Date(h.created_at).toISOString(),
  });

  app.get("/v1/tenants/:tenantId/farms/:farmId/harvests", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    return app.inTenant(req, "farm:read", async (tx) => {
      if (!(await getFarm(tx, farmId))) throw notFound("farm");
      return { items: (await listHarvests(tx, farmId)).map(toHarvest) };
    });
  });

  app.post("/v1/tenants/:tenantId/farms/:farmId/harvests", { config: { idempotency: "handler" } }, async (req, reply) => {
    const { tenantId, farmId } = parse(farmParams, req.params);
    const body = parse(createHarvestSchema, req.body);
    const status: AnchorStatus = anchoringConfigured() ? "pending" : "not_configured";
    const key = idempotencyKey(req);
    let replay = false;
    const row = await app.inTenant(req, "harvest:record", async (tx) => {
      const farm = await getFarm(tx, farmId);
      if (!farm) throw notFound("farm");
      if (key) {
        const seen = await findHarvestByRequest(tx, key);
        if (seen && (seen.farm_id !== farmId || seen.recorded_by !== req.user!.id)) throw keyReused();
        if (seen) {
          replay = true;
          return seen;
        }
      }
      if (farm.archived_at) throw new HttpError(409, "farm_archived", "restore the farm before recording harvests");
      if (body.taskId && !(await getTask(tx, farmId, body.taskId))) throw new HttpError(400, "invalid_task", "the task must belong to this farm");
      let seasonId = body.seasonId ?? null;
      if (seasonId && !(await getSeason(tx, farmId, seasonId))) throw new HttpError(400, "invalid_season", "the season must belong to this farm");
      if (body.seasonId === undefined) seasonId = (await findActiveSeason(tx, farmId, body.parcelLabel || null, body.cropName)) ?? null;
      const producer = await tenantName(tx);
      // Codes are random; a collision is astronomically unlikely, but retry rather than fail.
      for (let i = 0; ; i++) {
        const code = harvestCode();
        const record = buildHarvestRecord({ code, producer, farm: farm.name, harvest: body, recordedAt: app.deps.now() });
        const hash = await harvestRecordHash(record);
        try {
          await tx.query("SAVEPOINT harvest_code");
          const id = await insertHarvest(tx, farmId, { ...body, code, record, hash, anchorStatus: status, userId: req.user!.id, seasonId, clientRequestId: key });
          await app.audit(req, tx, { action: "harvest.recorded", targetType: "harvest_batch", targetId: id, metadata: { farmId, code, hash } });
          return (await getHarvest(tx, id))!;
        } catch (err) {
          if ((err as { code?: string }).code === "23505" && i < 3) {
            await tx.query("ROLLBACK TO SAVEPOINT harvest_code");
            continue;
          }
          throw err;
        }
      }
    });
    if (replay) return reply.status(200).send(toHarvest(row));
    if (status === "pending") await app.deps.jobs.enqueue(QUEUES.anchor, { tenantId, batchId: row.id, action: "record", attempt: row.anchor_attempt });
    return reply.status(201).send(toHarvest(row));
  });

  app.post("/v1/tenants/:tenantId/farms/:farmId/harvests/:batchId/void", async (req) => {
    const { tenantId, farmId, batchId } = parse(batchParams, req.params);
    const { reason } = parse(voidHarvestSchema, req.body);
    const { row, enqueue } = await app.inTenant(req, "harvest:manage", async (tx) => {
      const h = await getHarvest(tx, batchId, true);
      if (!h || h.farm_id !== farmId) throw notFound("harvest batch");
      if (h.voided_at) throw new HttpError(409, "already_voided", "this batch is already void");
      // Only a registered batch needs its void registered; a pending registration picks the void up when it finishes.
      const onChain = h.anchor_status === "confirmed" && anchoringConfigured();
      await voidHarvest(tx, batchId, reason, onChain ? "pending" : "not_configured");
      await app.audit(req, tx, { action: "harvest.voided", targetType: "harvest_batch", targetId: batchId, metadata: { farmId } });
      return { row: (await getHarvest(tx, batchId))!, enqueue: onChain };
    });
    if (enqueue) await app.deps.jobs.enqueue(QUEUES.anchor, { tenantId, batchId, action: "void", attempt: row.anchor_attempt });
    return toHarvest(row);
  });

  // Retry a failed registration, or register batches recorded before the chain was configured.
  app.post("/v1/tenants/:tenantId/farms/:farmId/harvests/:batchId/anchor", async (req) => {
    const { tenantId, farmId, batchId } = parse(batchParams, req.params);
    if (!anchoringConfigured()) throw new HttpError(409, "anchoring_not_configured", "blockchain registration is not configured on this server");
    const row = await app.inTenant(req, "harvest:manage", async (tx) => {
      const h = await getHarvest(tx, batchId, true);
      if (!h || h.farm_id !== farmId) throw notFound("harvest batch");
      if (h.anchor_status === "confirmed" || h.anchor_status === "submitted") {
        throw new HttpError(409, "already_registered", "this batch is registered or its registration is in progress");
      }
      await restartAnchoring(tx, batchId, "record");
      await app.audit(req, tx, { action: "harvest.anchor_retry", targetType: "harvest_batch", targetId: batchId, metadata: { farmId } });
      return (await getHarvest(tx, batchId))!;
    });
    await app.deps.jobs.enqueue(QUEUES.anchor, { tenantId, batchId, action: "record", attempt: row.anchor_attempt });
    return toHarvest(row);
  });

  // ── Public verification (no sign-in): the label code is the only key. ──
  app.get(
    "/v1/public/harvests/:code",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { code } = parse(z.object({ code: z.string().regex(HARVEST_CODE) }), req.params);
      const h = await withSystem(app.deps.pool, (tx) => getHarvestByCode(tx, code));
      if (!h) throw notFound("harvest batch");

      let chainCheck: { onChainHash: string | null; matches: boolean; registeredAt: string | null; voidedOnChain: boolean } | null = null;
      if (app.deps.harvestChain && h.anchor_status === "confirmed") {
        try {
          const e = await app.deps.harvestChain.entryOf(harvestChainId(h.id));
          const registered = e.recordedAt > 0n;
          chainCheck = {
            onChainHash: registered ? e.recordHash.toLowerCase() : null,
            matches: registered && e.recordHash.toLowerCase() === `0x${h.record_hash}`,
            registeredAt: registered ? new Date(Number(e.recordedAt) * 1000).toISOString() : null,
            voidedOnChain: e.voidedAt > 0n,
          };
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, "live registry check failed");
        }
      }
      reply.header("cache-control", "public, max-age=30");
      return {
        code: h.code,
        record: h.public_record,
        recordHash: h.record_hash,
        chainBatchId: harvestChainId(h.id),
        anchor: anchorInfo(h, env.CHAIN_EXPLORER_TX_URL, env.CHAIN_NAME),
        chainCheck,
        voidedAt: h.voided_at ? new Date(h.voided_at).toISOString() : null,
      };
    },
  );
}
