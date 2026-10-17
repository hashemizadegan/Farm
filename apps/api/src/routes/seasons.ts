import type { FastifyInstance } from "fastify";
import {
  getFarm,
  getSeason,
  insertSeason,
  insertStage,
  listSeasonHarvests,
  listSeasons,
  listStages,
  seasonInputUse,
  seasonTaskCounts,
  updateSeason,
  type SeasonRow,
} from "@metafarm/db";
import { createSeasonSchema, dayInZone, stageEntrySchema, sumByUnit, updateSeasonSchema, uuid, yieldPerHa } from "@metafarm/domain";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";

const farmParams = z.object({ tenantId: uuid, farmId: uuid });
const seasonParams = farmParams.extend({ seasonId: uuid });

export const toSeason = (s: SeasonRow) => ({
  id: s.id,
  farmId: s.farm_id,
  farmName: s.farm_name,
  cropName: s.crop_name,
  variety: s.variety,
  parcelLabel: s.parcel_label,
  areaHa: s.area_ha === null ? null : String(Number(s.area_ha)),
  plannedStart: s.planned_start,
  expectedHarvestFrom: s.expected_harvest_from,
  status: s.status,
  endedOn: s.ended_on,
  notes: s.notes,
  currentStage: s.current_stage,
  currentStageOn: s.current_stage_on,
  createdAt: new Date(s.created_at).toISOString(),
});

export async function seasonRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/farms/:farmId/seasons", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    return app.inTenant(req, "farm:read", async (tx) => {
      if (!(await getFarm(tx, farmId))) throw notFound("farm");
      return { items: (await listSeasons(tx, farmId)).map(toSeason) };
    });
  });

  app.post("/v1/tenants/:tenantId/farms/:farmId/seasons", async (req, reply) => {
    const { farmId } = parse(farmParams, req.params);
    const body = parse(createSeasonSchema, req.body);
    const s = await app.inTenant(req, "plan:write", async (tx) => {
      const farm = await getFarm(tx, farmId);
      if (!farm) throw notFound("farm");
      if (farm.archived_at) throw new HttpError(409, "farm_archived", "restore the farm before planning seasons");
      const id = await insertSeason(tx, farmId, body, req.user!.id);
      await app.audit(req, tx, { action: "season.created", targetType: "crop_season", targetId: id, metadata: { farmId, crop: body.cropName } });
      return (await getSeason(tx, farmId, id))!;
    });
    return reply.status(201).send(toSeason(s));
  });

  app.get("/v1/tenants/:tenantId/farms/:farmId/seasons/:seasonId", async (req) => {
    const { farmId, seasonId } = parse(seasonParams, req.params);
    return app.inTenant(req, "farm:read", async (tx) => {
      const farm = await getFarm(tx, farmId);
      const s = farm ? await getSeason(tx, farmId, seasonId) : undefined;
      if (!farm || !s) throw notFound("season");
      const today = dayInZone(app.deps.now(), farm.timezone);
      const [stages, harvests, inputs, tasks] = await Promise.all([
        listStages(tx, seasonId),
        listSeasonHarvests(tx, seasonId),
        seasonInputUse(tx, s, today),
        seasonTaskCounts(tx, s, today),
      ]);
      const valid = harvests.filter((h) => !h.voided_at);
      const totals = sumByUnit(valid.map((h) => ({ quantity: h.public_record.quantity, unit: h.unit })));
      return {
        season: toSeason(s),
        today,
        stages: stages.map((x) => ({ id: x.id, stage: x.stage, observedOn: x.observed_on, note: x.note, recordedByName: x.recorded_by_name })),
        harvest: {
          batches: harvests.map((h) => ({
            id: h.id,
            code: h.code,
            harvestedOn: h.harvested_on,
            quantity: h.public_record.quantity,
            unit: h.unit,
            voided: h.voided_at !== null,
          })),
          totals: totals.map((t) => ({ ...t, perHa: yieldPerHa(t.quantity, s.area_ha) })),
        },
        inputs: inputs.map((i) => ({ itemId: i.item_id, itemName: i.item_name, unit: i.unit, quantity: String(Number(i.quantity)), applications: i.applications })),
        tasks,
      };
    });
  });

  app.patch("/v1/tenants/:tenantId/farms/:farmId/seasons/:seasonId", async (req) => {
    const { farmId, seasonId } = parse(seasonParams, req.params);
    const body = parse(updateSeasonSchema, req.body);
    return app.inTenant(req, "plan:write", async (tx) => {
      const s = await getSeason(tx, farmId, seasonId);
      if (!s) throw notFound("season");
      const change = { ...body };
      if (change.status === "closed" && !change.endedOn) throw new HttpError(400, "ended_on_required", "give the day the season ended");
      if (change.status && change.status !== "closed") change.endedOn = null;
      if (change.endedOn && (change.status ?? s.status) !== "closed") throw new HttpError(400, "not_closed", "only a closed season has an end day");
      if (change.endedOn && change.endedOn < s.planned_start) throw new HttpError(400, "invalid_end", "a season cannot end before it starts");
      await updateSeason(tx, seasonId, change);
      await app.audit(req, tx, { action: "season.updated", targetType: "crop_season", targetId: seasonId, metadata: { farmId, fields: Object.keys(change) } });
      return toSeason((await getSeason(tx, farmId, seasonId))!);
    });
  });

  // Growth stages are field observations: workers record them too.
  app.post("/v1/tenants/:tenantId/farms/:farmId/seasons/:seasonId/stages", async (req, reply) => {
    const { farmId, seasonId } = parse(seasonParams, req.params);
    const body = parse(stageEntrySchema, req.body);
    const s = await app.inTenant(req, "observation:write", async (tx) => {
      const s = await getSeason(tx, farmId, seasonId);
      if (!s) throw notFound("season");
      if (s.status === "closed") throw new HttpError(409, "season_closed", "reopen the season to add stages");
      if (body.observedOn < s.planned_start) throw new HttpError(400, "before_start", "the stage is dated before the season starts");
      await insertStage(tx, seasonId, { ...body, userId: req.user!.id });
      await app.audit(req, tx, { action: "season.stage", targetType: "crop_season", targetId: seasonId, metadata: { stage: body.stage } });
      return (await getSeason(tx, farmId, seasonId))!;
    });
    return reply.status(201).send(toSeason(s));
  });
}
