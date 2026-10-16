import type { CropScenarioInput, CropScenarioResult, FarmPlanInput } from "@metafarm/domain";
import type { TenantTx } from "../tenant";

export interface FarmPlanRow {
  id: string;
  farm_id: string;
  name: string;
  season: string | null;
  parcels: FarmPlanInput["parcels"];
  provenance_label: "user-entered";
  created_at: string;
  updated_at: string;
}

export async function upsertFarmPlan(tx: TenantTx, farmId: string, input: FarmPlanInput, userId: string): Promise<FarmPlanRow> {
  const r = await tx.query<FarmPlanRow>(
    `INSERT INTO farm_plans (tenant_id, farm_id, name, season, parcels, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id, farm_id, name, season, parcels, provenance_label, created_at, updated_at`,
    [tx.tenantId, farmId, input.name, input.season ?? null, JSON.stringify(input.parcels), userId],
  );
  return r.rows[0]!;
}

export async function latestFarmPlan(tx: TenantTx, farmId: string): Promise<FarmPlanRow | undefined> {
  const r = await tx.query<FarmPlanRow>(
    `SELECT id, farm_id, name, season, parcels, provenance_label, created_at, updated_at
       FROM farm_plans WHERE tenant_id = $1 AND farm_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [tx.tenantId, farmId],
  );
  return r.rows[0];
}

export interface ScenarioRow {
  id: string;
  farm_id: string;
  kind: "simulated";
  input: CropScenarioInput;
  result: CropScenarioResult;
  created_at: string;
}

export async function insertScenario(
  tx: TenantTx,
  farmId: string,
  input: CropScenarioInput,
  result: CropScenarioResult,
  userId: string,
): Promise<ScenarioRow> {
  const r = await tx.query<ScenarioRow>(
    `INSERT INTO crop_scenarios (tenant_id, farm_id, input, result, created_by)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
     RETURNING id, farm_id, kind, input, result, created_at`,
    [tx.tenantId, farmId, JSON.stringify(input), JSON.stringify(result), userId],
  );
  return r.rows[0]!;
}

export async function listScenarios(tx: TenantTx, farmId: string): Promise<ScenarioRow[]> {
  const r = await tx.query<ScenarioRow>(
    `SELECT id, farm_id, kind, input, result, created_at FROM crop_scenarios
      WHERE tenant_id = $1 AND farm_id = $2 ORDER BY created_at DESC LIMIT 50`,
    [tx.tenantId, farmId],
  );
  return r.rows;
}

export interface AssetRow {
  id: string;
  tenant_id: string | null;
  kind: "plant" | "equipment" | "structure" | "decoration";
  name: string;
  description: string | null;
  model_media_id: string | null;
  procedural: Record<string, unknown> | null;
  license: string;
  provenance_label: "illustrative";
}

export async function listAssets(tx: TenantTx, kind?: AssetRow["kind"]): Promise<AssetRow[]> {
  const r = await tx.query<AssetRow>(
    `SELECT id, tenant_id, kind, name, description, model_media_id, procedural, license, provenance_label
       FROM asset_catalog
      WHERE (tenant_id IS NULL OR tenant_id = $1) AND ($2::text IS NULL OR kind = $2)
      ORDER BY kind, name`,
    [tx.tenantId, kind ?? null],
  );
  return r.rows;
}

export interface PlantInstanceRow {
  id: string;
  entity_key: string;
  asset_catalog_id: string | null;
  parcel_label: string | null;
  local_x: number;
  local_z: number;
  rotation_rad: number;
  scale: number;
  provenance_label: "illustrative" | "user-entered";
}

export async function listPlantInstances(tx: TenantTx, farmId: string): Promise<PlantInstanceRow[]> {
  const r = await tx.query<PlantInstanceRow>(
    `SELECT id, entity_key, asset_catalog_id, parcel_label, local_x, local_z, rotation_rad, scale, provenance_label
       FROM plant_instances WHERE tenant_id = $1 AND farm_id = $2 ORDER BY entity_key LIMIT 50000`,
    [tx.tenantId, farmId],
  );
  return r.rows;
}
