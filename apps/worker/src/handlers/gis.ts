import { getBoundaryVersion, overlappingBoundaries, postgisValidate, setBoundaryValidation, withTenant, writeAudit, type Pool } from "@metafarm/db";
import { NonRetryableJobError, type GisValidationJob } from "@metafarm/domain";
import type { Handler } from "../runner";

/**
 * Authoritative boundary validation in PostGIS. The API already ran the fast
 * TypeScript checks; this confirms validity with ST_IsValidDetail, recomputes
 * the geodesic area with PostGIS, and records overlaps with the tenant's other
 * farms as informational warnings (overlap is not proof of a conflict).
 */
export function gisValidationHandler(pool: Pool): Handler<GisValidationJob> {
  return async (job, { log }) =>
    withTenant(pool, job.tenantId, async (tx) => {
      const b = await getBoundaryVersion(tx, job.farmId, job.boundaryVersionId);
      if (!b) throw new NonRetryableJobError("boundary version not found");
      if (b.validation_status !== "pending") {
        log.info({ status: b.validation_status }, "boundary already validated");
        return { status: b.validation_status };
      }
      const check = await postgisValidate(tx, b.id);
      if (!check) throw new NonRetryableJobError("boundary disappeared during validation");
      const issues: { code: string; message: string }[] = [];
      if (!check.valid) issues.push({ code: "POSTGIS_INVALID", message: check.reason ?? "invalid geometry" });
      if (check.srid !== 4326) issues.push({ code: "UNSUPPORTED_CRS", message: `unexpected SRID ${check.srid}` });

      const status = issues.length === 0 ? "valid" : "invalid";
      await setBoundaryValidation(tx, b.id, status, issues, check.area_m2);
      const overlaps = status === "valid" ? await overlappingBoundaries(tx, b.id) : [];
      await writeAudit(tx, {
        actorType: "job",
        action: `boundary.validation_${status}`,
        targetType: "boundary_version",
        targetId: b.id,
        metadata: { issues: issues.map((i) => i.code), overlaps: overlaps.length },
      });
      log.info({ status, overlaps: overlaps.length }, "boundary validated");
      return { status, overlaps: overlaps.length };
    });
}
