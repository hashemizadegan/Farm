import type { BoundaryGeometry, ProvenanceLabel } from "@metafarm/domain";
import type { TenantTx } from "../tenant";

export interface FarmRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  timezone: string;
  origin: { lon: number; lat: number } | null;
  origin_provenance: ProvenanceLabel;
  current_boundary_version_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const FARM_COLUMNS = `
  f.id, f.tenant_id, f.name, f.description, f.timezone,
  CASE WHEN f.origin IS NULL THEN NULL
       ELSE json_build_object('lon', ST_X(f.origin), 'lat', ST_Y(f.origin)) END AS origin,
  f.origin_provenance, f.current_boundary_version_id, f.archived_at, f.created_at, f.updated_at`;

export async function createFarm(
  tx: TenantTx,
  input: { name: string; description?: string; timezone: string; origin?: { lon: number; lat: number }; createdBy: string },
): Promise<FarmRow> {
  const r = await tx.query<FarmRow>(
    `INSERT INTO farms AS f (tenant_id, name, description, timezone, origin, created_by)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $5::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($5, $6), 4326) END,
             $7)
     RETURNING ${FARM_COLUMNS}`,
    [tx.tenantId, input.name, input.description ?? null, input.timezone, input.origin?.lon ?? null, input.origin?.lat ?? null, input.createdBy],
  );
  return r.rows[0]!;
}

export async function listFarms(
  tx: TenantTx,
  limit: number,
  cursor?: string,
  status: "active" | "archived" = "active",
): Promise<FarmRow[]> {
  const r = await tx.query<FarmRow>(
    `SELECT ${FARM_COLUMNS} FROM farms f
      WHERE f.tenant_id = $1 AND ($2::timestamptz IS NULL OR f.created_at < $2)
        AND (CASE WHEN $4 = 'archived' THEN f.archived_at IS NOT NULL ELSE f.archived_at IS NULL END)
      ORDER BY f.created_at DESC LIMIT $3`,
    [tx.tenantId, cursor ?? null, limit, status],
  );
  return r.rows;
}

/** Updates editable farm details. Undefined fields are left unchanged; description null clears it. */
export async function updateFarm(
  tx: TenantTx,
  farmId: string,
  input: { name?: string; description?: string | null; timezone?: string },
): Promise<FarmRow | undefined> {
  const r = await tx.query<FarmRow>(
    `UPDATE farms AS f SET
        name = COALESCE($3, f.name),
        description = CASE WHEN $4::boolean THEN $5 ELSE f.description END,
        timezone = COALESCE($6, f.timezone)
      WHERE f.tenant_id = $1 AND f.id = $2
      RETURNING ${FARM_COLUMNS}`,
    [tx.tenantId, farmId, input.name ?? null, input.description !== undefined, input.description ?? null, input.timezone ?? null],
  );
  return r.rows[0];
}

/** Archives (hides from the default list) or restores a farm. Data is kept. */
export async function setFarmArchived(tx: TenantTx, farmId: string, archived: boolean): Promise<FarmRow | undefined> {
  const r = await tx.query<FarmRow>(
    `UPDATE farms AS f SET archived_at = CASE WHEN $3 THEN COALESCE(f.archived_at, now()) ELSE NULL END
      WHERE f.tenant_id = $1 AND f.id = $2
      RETURNING ${FARM_COLUMNS}`,
    [tx.tenantId, farmId, archived],
  );
  return r.rows[0];
}

export async function getFarm(tx: TenantTx, farmId: string): Promise<FarmRow | undefined> {
  const r = await tx.query<FarmRow>(`SELECT ${FARM_COLUMNS} FROM farms f WHERE f.tenant_id = $1 AND f.id = $2`, [
    tx.tenantId,
    farmId,
  ]);
  return r.rows[0];
}

export interface BoundaryRow {
  id: string;
  farm_id: string;
  version: number;
  geojson: BoundaryGeometry;
  crs: string;
  source: "drawn" | "imported" | "coordinates";
  provenance_label: ProvenanceLabel;
  geometry_hash: string;
  area_m2: number;
  vertex_count: number;
  validation_status: "pending" | "valid" | "invalid";
  validation_issues: unknown[];
  note: string | null;
  submitted_at: string;
  validated_at: string | null;
}

const BOUNDARY_COLUMNS = `
  b.id, b.farm_id, b.version, ST_AsGeoJSON(b.geom, 7)::json AS geojson, b.crs, b.source, b.provenance_label,
  b.geometry_hash, b.area_m2, b.vertex_count, b.validation_status, b.validation_issues, b.note,
  b.submitted_at, b.validated_at`;

export async function boundaryHashExists(tx: TenantTx, hash: string): Promise<boolean> {
  const r = await tx.query(
    `SELECT 1 FROM boundary_versions WHERE tenant_id = $1 AND geometry_hash = $2 AND validation_status <> 'invalid' LIMIT 1`,
    [tx.tenantId, hash],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function insertBoundaryVersion(
  tx: TenantTx,
  input: {
    farmId: string;
    geometry: BoundaryGeometry;
    source: BoundaryRow["source"];
    geometryHash: string;
    areaM2: number;
    vertexCount: number;
    note?: string;
    submittedBy: string;
  },
): Promise<BoundaryRow> {
  // Lock the farm row so concurrent submissions get sequential version numbers.
  const farm = await tx.query(`SELECT id FROM farms WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tx.tenantId, input.farmId]);
  if (farm.rowCount === 0) throw new Error("farm not found");
  const r = await tx.query<BoundaryRow>(
    `INSERT INTO boundary_versions AS b
       (tenant_id, farm_id, version, geom, source, geometry_hash, area_m2, vertex_count, note, submitted_by)
     VALUES ($1, $2,
             COALESCE((SELECT max(version) FROM boundary_versions WHERE tenant_id = $1 AND farm_id = $2), 0) + 1,
             ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)),
             $4, $5, $6, $7, $8, $9)
     RETURNING ${BOUNDARY_COLUMNS}`,
    [
      tx.tenantId,
      input.farmId,
      JSON.stringify(input.geometry),
      input.source,
      input.geometryHash,
      input.areaM2,
      input.vertexCount,
      input.note ?? null,
      input.submittedBy,
    ],
  );
  return r.rows[0]!;
}

export async function getBoundaryVersion(tx: TenantTx, farmId: string, boundaryId: string): Promise<BoundaryRow | undefined> {
  const r = await tx.query<BoundaryRow>(
    `SELECT ${BOUNDARY_COLUMNS} FROM boundary_versions b WHERE b.tenant_id = $1 AND b.farm_id = $2 AND b.id = $3`,
    [tx.tenantId, farmId, boundaryId],
  );
  return r.rows[0];
}

export async function listBoundaryVersions(tx: TenantTx, farmId: string): Promise<BoundaryRow[]> {
  const r = await tx.query<BoundaryRow>(
    `SELECT ${BOUNDARY_COLUMNS} FROM boundary_versions b WHERE b.tenant_id = $1 AND b.farm_id = $2 ORDER BY b.version DESC`,
    [tx.tenantId, farmId],
  );
  return r.rows;
}

/**
 * Authoritative PostGIS validation, run by the GIS worker. Returns PostGIS's
 * own validity verdict and reason; the TypeScript validator is a fast pre-check.
 */
export async function postgisValidate(tx: TenantTx, boundaryId: string) {
  const r = await tx.query<{ valid: boolean; reason: string | null; area_m2: number; srid: number }>(
    `SELECT (ST_IsValidDetail(geom)).valid AS valid,
            (ST_IsValidDetail(geom)).reason AS reason,
            ST_Area(geom::geography) AS area_m2,
            ST_SRID(geom) AS srid
       FROM boundary_versions WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, boundaryId],
  );
  return r.rows[0];
}

/** Boundaries of other farms in the same tenant that overlap this one (for a warning, not a rejection). */
export async function overlappingBoundaries(tx: TenantTx, boundaryId: string): Promise<{ farm_id: string; overlap_m2: number }[]> {
  const r = await tx.query<{ farm_id: string; overlap_m2: number }>(
    `SELECT o.farm_id, ST_Area(ST_Intersection(b.geom, o.geom)::geography) AS overlap_m2
       FROM boundary_versions b
       JOIN farms f ON f.tenant_id = b.tenant_id AND f.current_boundary_version_id IS NOT NULL
       JOIN boundary_versions o ON o.id = f.current_boundary_version_id AND o.tenant_id = b.tenant_id
      WHERE b.tenant_id = $1 AND b.id = $2 AND o.farm_id <> b.farm_id AND ST_Intersects(b.geom, o.geom)`,
    [tx.tenantId, boundaryId],
  );
  return r.rows;
}

export async function setBoundaryValidation(
  tx: TenantTx,
  boundaryId: string,
  status: "valid" | "invalid",
  issues: unknown[],
  areaM2?: number,
): Promise<void> {
  await tx.query(
    `UPDATE boundary_versions
        SET validation_status = $3, validation_issues = $4::jsonb, validated_at = now(),
            area_m2 = COALESCE($5, area_m2)
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, boundaryId, status, JSON.stringify(issues), areaM2 ?? null],
  );
  if (status === "valid") {
    await tx.query(
      `UPDATE farms f SET current_boundary_version_id = b.id
         FROM boundary_versions b
        WHERE b.tenant_id = $1 AND b.id = $2 AND f.tenant_id = $1 AND f.id = b.farm_id
          AND (f.current_boundary_version_id IS NULL
               OR b.version > (SELECT version FROM boundary_versions WHERE id = f.current_boundary_version_id))`,
      [tx.tenantId, boundaryId],
    );
  }
}

/**
 * Attaches verification evidence and marks the boundary independently-verified
 * in one transaction. The database trigger rejects the label without evidence.
 */
export async function addVerificationEvidence(
  tx: TenantTx,
  input: {
    boundaryId: string;
    kind: "survey-document" | "registry-extract" | "field-inspection" | "other";
    mediaObjectId: string;
    reviewerUserId: string;
    note?: string;
  },
): Promise<{ evidenceId: string }> {
  const media = await tx.query<{ status: string; purpose: string }>(
    `SELECT status, purpose FROM media_objects WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, input.mediaObjectId],
  );
  const m = media.rows[0];
  if (!m || m.status !== "uploaded" || m.purpose !== "verification-evidence") {
    throw new Error("evidence media must be an uploaded verification-evidence object");
  }
  const r = await tx.query<{ id: string }>(
    `INSERT INTO verification_evidence (tenant_id, boundary_version_id, kind, media_object_id, reviewer_user_id, note)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tx.tenantId, input.boundaryId, input.kind, input.mediaObjectId, input.reviewerUserId, input.note ?? null],
  );
  await tx.query(
    `UPDATE boundary_versions SET provenance_label = 'independently-verified'
      WHERE tenant_id = $1 AND id = $2 AND validation_status = 'valid'`,
    [tx.tenantId, input.boundaryId],
  );
  return { evidenceId: r.rows[0]!.id };
}
