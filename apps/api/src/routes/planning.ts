import type { FastifyInstance } from "fastify";
import {
  getBoundaryVersion,
  getFarm,
  insertScenario,
  latestFarmPlan,
  listAssets,
  listScenarios,
  upsertFarmPlan,
} from "@metafarm/db";
import { cropScenarioSchema, farmPlanSchema, m2ToHa, runCropScenario, ScenarioInputError, uuid } from "@metafarm/domain";
import { buildScene } from "@metafarm/map-scene/core";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";
import { toPlan, toScenario } from "../lib/mappers";

const farmParams = z.object({ tenantId: uuid, farmId: uuid });

export async function planningRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/farms/:farmId/plan", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    return app.inTenant(req, "farm:read", async (tx) => {
      const plan = await latestFarmPlan(tx, farmId);
      if (!plan) throw notFound("plan");
      return toPlan(plan);
    });
  });

  app.put("/v1/tenants/:tenantId/farms/:farmId/plan", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    const body = parse(farmPlanSchema, req.body);
    const total = body.parcels.reduce((s, p) => s + p.grid.rows * p.grid.cols, 0);
    if (total > 100_000) throw new HttpError(400, "plan_too_large", "a plan may contain at most 100,000 planting positions");
    return app.inTenant(req, "plan:write", async (tx) => {
      if (!(await getFarm(tx, farmId))) throw notFound("farm");
      const plan = await upsertFarmPlan(tx, farmId, body, req.user!.id);
      await app.audit(req, tx, { action: "plan.saved", targetType: "farm_plan", targetId: plan.id, metadata: { farmId, parcels: body.parcels.length } });
      return toPlan(plan);
    });
  });

  app.get("/v1/tenants/:tenantId/farms/:farmId/scenarios", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    return app.inTenant(req, "farm:read", async (tx) => ({ items: (await listScenarios(tx, farmId)).map(toScenario) }));
  });

  app.post("/v1/tenants/:tenantId/farms/:farmId/scenarios", async (req, reply) => {
    const { farmId } = parse(farmParams, req.params);
    const body = parse(cropScenarioSchema, req.body);
    const row = await app.inTenant(req, "scenario:write", async (tx) => {
      const farm = await getFarm(tx, farmId);
      if (!farm) throw notFound("farm");
      let areaHa = body.plantedAreaHa;
      if (areaHa === undefined) {
        const b = farm.current_boundary_version_id
          ? await getBoundaryVersion(tx, farmId, farm.current_boundary_version_id)
          : undefined;
        if (!b) throw new HttpError(400, "area_required", "plantedAreaHa is required until the farm has a validated boundary");
        areaHa = m2ToHa(b.area_m2);
      }
      const input = { ...body, plantedAreaHa: areaHa };
      let result;
      try {
        result = runCropScenario(input);
      } catch (err) {
        if (err instanceof ScenarioInputError) throw new HttpError(400, "invalid_scenario", err.message);
        throw err;
      }
      const s = await insertScenario(tx, farmId, input, result, req.user!.id);
      await app.audit(req, tx, { action: "scenario.created", targetType: "crop_scenario", targetId: s.id, metadata: { farmId } });
      return s;
    });
    return reply.status(201).send(toScenario(row));
  });

  app.get("/v1/tenants/:tenantId/assets", async (req) => {
    const { kind } = parse(z.object({ kind: z.enum(["plant", "equipment", "structure", "decoration"]).optional() }), req.query);
    return app.inTenant(req, "asset:read", async (tx) => ({
      items: (await listAssets(tx, kind)).map((a) => ({
        id: a.id,
        kind: a.kind,
        name: a.name,
        description: a.description,
        procedural: a.procedural,
        modelMediaId: a.model_media_id,
        license: a.license,
        provenance: a.provenance_label,
        scope: a.tenant_id ? "tenant" : "global",
      })),
    }));
  });

  app.get("/v1/tenants/:tenantId/farms/:farmId/scene", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    return app.inTenant(req, "farm:read", async (tx) => {
      const farm = await getFarm(tx, farmId);
      if (!farm) throw notFound("farm");
      const boundary = farm.current_boundary_version_id
        ? await getBoundaryVersion(tx, farmId, farm.current_boundary_version_id)
        : undefined;
      const plan = await latestFarmPlan(tx, farmId);
      const catalog = await listAssets(tx);
      return buildScene({
        farmId,
        origin: farm.origin,
        boundary: boundary?.geojson ?? null,
        parcels: plan?.parcels ?? [],
        catalog: catalog.map((c) => ({ id: c.id, kind: c.kind, name: c.name })),
      });
    });
  });
}
