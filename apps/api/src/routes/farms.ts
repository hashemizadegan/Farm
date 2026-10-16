import type { FastifyInstance } from "fastify";
import {
  addVerificationEvidence,
  boundaryHashExists,
  createFarm,
  getBoundaryVersion,
  getFarm,
  insertBoundaryVersion,
  listBoundaryVersions,
  listFarms,
  listUserTenants,
  overlappingBoundaries,
  type TenantTx,
} from "@metafarm/db";
import {
  QUEUES,
  createFarmSchema,
  paginationSchema,
  submitBoundarySchema,
  uuid,
  validateBoundary,
  type GeometryLimits,
  DEFAULT_GEOMETRY_LIMITS,
} from "@metafarm/domain";
import { geometryHash } from "@metafarm/domain/server";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";
import { toBoundary, toFarm } from "../lib/mappers";

const farmParams = z.object({ tenantId: uuid, farmId: uuid });

export async function farmRoutes(app: FastifyInstance) {
  app.get("/v1/me", async (req) => {
    await app.authenticate(req);
    const tenants = await listUserTenants(app.deps.pool, req.user!.id);
    return {
      userId: req.user!.id,
      displayName: req.user!.displayName,
      tenants: tenants.map((t) => ({ tenantId: t.tenant_id, slug: t.slug, name: t.name, role: t.role })),
    };
  });

  app.get("/v1/tenants/:tenantId/farms", async (req) => {
    const q = parse(paginationSchema, req.query);
    return app.inTenant(req, "farm:read", async (tx) => {
      const rows = await listFarms(tx, q.limit + 1, q.cursor);
      const page = rows.slice(0, q.limit);
      return {
        items: page.map(toFarm),
        nextCursor: rows.length > q.limit ? new Date(page[page.length - 1]!.created_at).toISOString() : null,
      };
    });
  });

  app.post("/v1/tenants/:tenantId/farms", async (req, reply) => {
    const body = parse(createFarmSchema, req.body);
    const farm = await app.inTenant(req, "farm:write", async (tx) => {
      const f = await createFarm(tx, { ...body, createdBy: req.user!.id });
      await app.audit(req, tx, { action: "farm.created", targetType: "farm", targetId: f.id });
      return f;
    });
    return reply.status(201).send(toFarm(farm));
  });

  app.get("/v1/tenants/:tenantId/farms/:farmId", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    return app.inTenant(req, "farm:read", async (tx) => {
      const f = await getFarm(tx, farmId);
      if (!f) throw notFound("farm");
      return toFarm(f);
    });
  });

  app.get("/v1/tenants/:tenantId/farms/:farmId/boundaries", async (req) => {
    const { farmId } = parse(farmParams, req.params);
    return app.inTenant(req, "farm:read", async (tx) => {
      if (!(await getFarm(tx, farmId))) throw notFound("farm");
      return { items: (await listBoundaryVersions(tx, farmId)).map((b) => toBoundary(b)) };
    });
  });

  app.get("/v1/tenants/:tenantId/farms/:farmId/boundaries/:boundaryId", async (req) => {
    const { farmId, boundaryId } = parse(farmParams.extend({ boundaryId: uuid }), req.params);
    return app.inTenant(req, "farm:read", async (tx) => {
      const b = await getBoundaryVersion(tx, farmId, boundaryId);
      if (!b) throw notFound("boundary");
      const overlaps = b.validation_status === "valid" ? await overlappingBoundaries(tx, b.id) : undefined;
      return toBoundary(b, overlaps);
    });
  });

  /**
   * A verifier attaches evidence (an uploaded verification-evidence document).
   * Only then does the boundary become `independently-verified`.
   */
  app.post("/v1/tenants/:tenantId/farms/:farmId/boundaries/:boundaryId/evidence", async (req, reply) => {
    const { farmId, boundaryId } = parse(farmParams.extend({ boundaryId: uuid }), req.params);
    const body = parse(
      z.object({
        kind: z.enum(["survey-document", "registry-extract", "field-inspection", "other"]),
        mediaObjectId: uuid,
        note: z.string().max(2_000).optional(),
      }),
      req.body,
    );
    const out = await app.inTenant(req, "boundary:verify", async (tx) => {
      const b = await getBoundaryVersion(tx, farmId, boundaryId);
      if (!b) throw notFound("boundary");
      if (b.validation_status !== "valid") {
        throw new HttpError(409, "boundary_not_valid", "only geometrically valid boundaries can be verified");
      }
      let res;
      try {
        res = await addVerificationEvidence(tx, { boundaryId, ...body, reviewerUserId: req.user!.id });
      } catch (err) {
        throw new HttpError(422, "invalid_evidence", (err as Error).message);
      }
      await app.audit(req, tx, {
        action: "boundary.verified",
        targetType: "boundary_version",
        targetId: boundaryId,
        metadata: { evidenceId: res.evidenceId, kind: body.kind },
      });
      return toBoundary((await getBoundaryVersion(tx, farmId, boundaryId))!);
    });
    return reply.status(201).send(out);
  });

  app.post(
    "/v1/tenants/:tenantId/farms/:farmId/boundaries",
    // Boundaries are the largest legitimate JSON bodies; allow more than the default but still bounded.
    { bodyLimit: 2 * 1024 * 1024 },
    async (req, reply) => {
      const { farmId } = parse(farmParams, req.params);
      const body = parse(submitBoundarySchema, req.body);
      const result = await app.inTenant(req, "boundary:submit", async (tx, ctx) => {
        if (!(await getFarm(tx, farmId))) throw notFound("farm");
        const limits = await tenantGeometryLimits(tx, ctx.id);
        const v = validateBoundary(body.geojson, limits);
        if (!v.valid || !v.geometry || !v.canonicalKey || v.areaM2 === undefined) {
          await app.audit(req, tx, { action: "boundary.rejected", targetType: "farm", targetId: farmId, outcome: "failure", metadata: { codes: v.issues.map((i) => i.code) } });
          throw new HttpError(422, "geometry_rejected", "boundary geometry is invalid", v.issues);
        }
        const hash = geometryHash(v.canonicalKey);
        if (await boundaryHashExists(tx, hash)) {
          throw new HttpError(409, "duplicate_geometry", "an identical boundary already exists in this tenant", [
            { code: "DUPLICATE_GEOMETRY", message: "an identical boundary already exists in this tenant" },
          ]);
        }
        const row = await insertBoundaryVersion(tx, {
          farmId,
          geometry: v.geometry,
          source: body.source,
          geometryHash: hash,
          areaM2: v.areaM2,
          vertexCount: v.vertexCount,
          note: body.note,
          submittedBy: req.user!.id,
        });
        await app.audit(req, tx, {
          action: "boundary.submitted",
          targetType: "boundary_version",
          targetId: row.id,
          metadata: { farmId, version: row.version, source: body.source, vertexCount: v.vertexCount },
        });
        return row;
      });
      await app.deps.jobs.enqueue(QUEUES.gis, { tenantId: (req.params as { tenantId: string }).tenantId, farmId, boundaryVersionId: result.id });
      return reply.status(202).send(toBoundary(result));
    },
  );
}

async function tenantGeometryLimits(tx: TenantTx, tenantId: string): Promise<GeometryLimits> {
  const r = await tx.query<{ settings: Record<string, unknown> }>(`SELECT settings FROM tenants WHERE id = $1`, [tenantId]);
  const s = (r.rows[0]?.settings?.geometryLimits ?? {}) as Partial<GeometryLimits>;
  // Tenants may tighten limits but never loosen them beyond platform defaults.
  return {
    maxVertices: Math.min(s.maxVertices ?? Infinity, DEFAULT_GEOMETRY_LIMITS.maxVertices),
    maxRingsPerPolygon: Math.min(s.maxRingsPerPolygon ?? Infinity, DEFAULT_GEOMETRY_LIMITS.maxRingsPerPolygon),
    maxPolygons: Math.min(s.maxPolygons ?? Infinity, DEFAULT_GEOMETRY_LIMITS.maxPolygons),
    minAreaM2: Math.max(s.minAreaM2 ?? 0, DEFAULT_GEOMETRY_LIMITS.minAreaM2),
    maxAreaM2: Math.min(s.maxAreaM2 ?? Infinity, DEFAULT_GEOMETRY_LIMITS.maxAreaM2),
    maxDepth: DEFAULT_GEOMETRY_LIMITS.maxDepth,
  };
}
