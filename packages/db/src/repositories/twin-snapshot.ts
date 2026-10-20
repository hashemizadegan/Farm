/**
 * The entities of one farm, shaped for a farm-state snapshot (packages/domain/src/twin/snapshot.ts).
 * Every value is built in SQL as plain JSON: dates and decimals as text, so nothing changes on the
 * way through JavaScript and the hashes stay reproducible. No personal data (no user ids, notes or
 * free text beyond names and labels) goes into a snapshot.
 */
import type { SnapshotEntityInput } from "@metafarm/domain";
import type { SystemTx, TenantTx } from "../tenant";

const ASSET_TYPE = `CASE a.kind
    WHEN 'parcel' THEN 'plot' WHEN 'tree' THEN 'crop' WHEN 'livestock' THEN 'animal'
    WHEN 'building' THEN 'structure' WHEN 'storage_unit' THEN 'structure' WHEN 'equipment' THEN 'machine'
    ELSE 'asset' END`;

export async function farmSnapshotEntities(tx: TenantTx, farmId: string): Promise<SnapshotEntityInput[]> {
  const r = await tx.query<SnapshotEntityInput>(
    `SELECT ${ASSET_TYPE} AS type, a.id::text AS id,
            jsonb_build_object(
              'source', 'business_asset', 'kind', a.kind, 'name', a.name, 'status', a.status,
              'externalRef', a.external_ref, 'parcelLabel', a.parcel_label, 'geomProvenance', a.geom_provenance,
              'geometry', CASE WHEN a.geom IS NULL THEN NULL ELSE ST_AsGeoJSON(a.geom, 7)::jsonb END,
              'verifiedAt', to_char(a.verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS data
       FROM business_assets a
      WHERE a.tenant_id = $1 AND a.farm_id = $2 AND a.status <> 'retired'
     UNION ALL
     SELECT 'machine', e.id::text,
            jsonb_build_object(
              'source', 'equipment', 'kind', e.kind, 'name', e.name, 'status', e.status, 'tracksHours', e.tracks_hours,
              'hourMeter', (SELECT m.hours::text FROM meter_readings m WHERE m.tenant_id = e.tenant_id AND m.equipment_id = e.id ORDER BY m.read_on DESC, m.created_at DESC LIMIT 1))
       FROM equipment e
      WHERE e.tenant_id = $1 AND e.farm_id = $2 AND e.status <> 'retired'
     UNION ALL
     SELECT 'crop', s.id::text,
            jsonb_build_object(
              'source', 'crop_season', 'crop', s.crop_name, 'variety', s.variety, 'parcelLabel', s.parcel_label,
              'areaHa', s.area_ha::text, 'status', s.status, 'plannedStart', s.planned_start::text,
              'expectedHarvestFrom', s.expected_harvest_from::text, 'endedOn', s.ended_on::text)
       FROM crop_seasons s
      WHERE s.tenant_id = $1 AND s.farm_id = $2
     UNION ALL
     SELECT 'inventory', i.id::text,
            jsonb_build_object('source', 'input_item', 'name', i.name, 'category', i.category, 'unit', i.unit,
                               'netQuantityOnFarm', sum(sm.quantity)::text)
       FROM input_items i JOIN stock_movements sm ON sm.tenant_id = i.tenant_id AND sm.item_id = i.id
      WHERE i.tenant_id = $1 AND sm.farm_id = $2 AND i.archived_at IS NULL
      GROUP BY i.id, i.name, i.category, i.unit`,
    [tx.tenantId, farmId],
  );
  return r.rows;
}

/** Farms that have something to snapshot (system-wide; for the scheduled sweep). */
export async function farmsToSnapshot(tx: SystemTx, limit = 5_000): Promise<{ tenant_id: string; farm_id: string }[]> {
  return (
    await tx.query<{ tenant_id: string; farm_id: string }>(
      `SELECT f.tenant_id, f.id AS farm_id
         FROM farms f
        WHERE f.archived_at IS NULL
          AND (EXISTS (SELECT 1 FROM business_assets a WHERE a.tenant_id = f.tenant_id AND a.farm_id = f.id AND a.status <> 'retired')
            OR EXISTS (SELECT 1 FROM equipment e WHERE e.tenant_id = f.tenant_id AND e.farm_id = f.id AND e.status <> 'retired')
            OR EXISTS (SELECT 1 FROM crop_seasons s WHERE s.tenant_id = f.tenant_id AND s.farm_id = f.id)
            OR EXISTS (SELECT 1 FROM stock_movements m WHERE m.tenant_id = f.tenant_id AND m.farm_id = f.id))
        ORDER BY f.tenant_id, f.id
        LIMIT $1`,
      [limit],
    )
  ).rows;
}
