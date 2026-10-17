import type { CreateSeasonInput, SeasonStage, SeasonStatus, UpdateSeasonInput } from "@metafarm/domain";
import type { TenantTx } from "../tenant";

export interface SeasonRow {
  id: string;
  farm_id: string;
  farm_name: string;
  crop_name: string;
  variety: string | null;
  parcel_label: string | null;
  area_ha: string | null;
  planned_start: string;
  expected_harvest_from: string | null;
  status: SeasonStatus;
  ended_on: string | null;
  notes: string | null;
  current_stage: SeasonStage | null;
  current_stage_on: string | null;
  created_at: string;
}

const SELECT = `
  SELECT s.id, s.farm_id, f.name AS farm_name, s.crop_name, s.variety, s.parcel_label, s.area_ha::text AS area_ha,
         to_char(s.planned_start, 'YYYY-MM-DD') AS planned_start, to_char(s.expected_harvest_from, 'YYYY-MM-DD') AS expected_harvest_from,
         s.status, to_char(s.ended_on, 'YYYY-MM-DD') AS ended_on, s.notes, st.stage AS current_stage,
         to_char(st.observed_on, 'YYYY-MM-DD') AS current_stage_on, s.created_at
    FROM crop_seasons s
    JOIN farms f ON f.tenant_id = s.tenant_id AND f.id = s.farm_id
    LEFT JOIN LATERAL (
      SELECT stage, observed_on FROM season_stages x
       WHERE x.tenant_id = s.tenant_id AND x.season_id = s.id ORDER BY x.observed_on DESC, x.created_at DESC LIMIT 1
    ) st ON true`;

export async function listSeasons(tx: TenantTx, farmId: string): Promise<SeasonRow[]> {
  const r = await tx.query<SeasonRow>(
    `${SELECT} WHERE s.tenant_id = $1 AND s.farm_id = $2
      ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, s.planned_start DESC LIMIT 200`,
    [tx.tenantId, farmId],
  );
  return r.rows;
}

export async function getSeason(tx: TenantTx, farmId: string, id: string): Promise<SeasonRow | undefined> {
  const r = await tx.query<SeasonRow>(`${SELECT} WHERE s.tenant_id = $1 AND s.farm_id = $2 AND s.id = $3`, [tx.tenantId, farmId, id]);
  return r.rows[0];
}

export async function insertSeason(tx: TenantTx, farmId: string, input: CreateSeasonInput, userId: string): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO crop_seasons (tenant_id, farm_id, crop_name, variety, parcel_label, area_ha, planned_start, expected_harvest_from, status, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::date, $8::date, $9, $10, $11) RETURNING id`,
    [
      tx.tenantId,
      farmId,
      input.cropName,
      input.variety || null,
      input.parcelLabel || null,
      input.areaHa ?? null,
      input.plannedStart,
      input.expectedHarvestFrom ?? null,
      input.status,
      input.notes || null,
      userId,
    ],
  );
  return r.rows[0]!.id;
}

const COLUMNS: Record<keyof UpdateSeasonInput, string> = {
  variety: "variety",
  areaHa: "area_ha",
  expectedHarvestFrom: "expected_harvest_from",
  notes: "notes",
  status: "status",
  endedOn: "ended_on",
};
const CASTS: Partial<Record<keyof UpdateSeasonInput, string>> = { areaHa: "::numeric", expectedHarvestFrom: "::date", endedOn: "::date" };

export async function updateSeason(tx: TenantTx, id: string, input: UpdateSeasonInput): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [tx.tenantId, id];
  for (const [k, v] of Object.entries(input) as [keyof UpdateSeasonInput, unknown][]) {
    params.push(v === "" ? null : v);
    sets.push(`${COLUMNS[k]} = $${params.length}${CASTS[k] ?? ""}`);
  }
  await tx.query(`UPDATE crop_seasons SET ${sets.join(", ")}, updated_at = now() WHERE tenant_id = $1 AND id = $2`, params);
}

export interface StageRow {
  id: string;
  stage: SeasonStage;
  observed_on: string;
  note: string | null;
  recorded_by_name: string | null;
}

export async function listStages(tx: TenantTx, seasonId: string): Promise<StageRow[]> {
  const r = await tx.query<StageRow>(
    `SELECT x.id, x.stage, to_char(x.observed_on, 'YYYY-MM-DD') AS observed_on, x.note, coalesce(u.display_name, u.email::text) AS recorded_by_name
       FROM season_stages x LEFT JOIN users u ON u.id = x.recorded_by
      WHERE x.tenant_id = $1 AND x.season_id = $2 ORDER BY x.observed_on, x.created_at`,
    [tx.tenantId, seasonId],
  );
  return r.rows;
}

export async function insertStage(tx: TenantTx, seasonId: string, e: { stage: SeasonStage; observedOn: string; note?: string | null; userId: string }) {
  await tx.query(`INSERT INTO season_stages (tenant_id, season_id, stage, observed_on, note, recorded_by) VALUES ($1, $2, $3, $4::date, $5, $6)`, [
    tx.tenantId,
    seasonId,
    e.stage,
    e.observedOn,
    e.note || null,
    e.userId,
  ]);
}

/** The single active season for a crop on a parcel, used to attach harvests automatically. */
export async function findActiveSeason(tx: TenantTx, farmId: string, parcelLabel: string | null, cropName: string): Promise<string | undefined> {
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM crop_seasons
      WHERE tenant_id = $1 AND farm_id = $2 AND status = 'active' AND lower(crop_name) = lower($4)
        AND (parcel_label IS NULL AND $3::text IS NULL OR lower(parcel_label) = lower($3::text))`,
    [tx.tenantId, farmId, parcelLabel, cropName],
  );
  return r.rows.length === 1 ? r.rows[0]!.id : undefined;
}

/** Inputs used on the season's farm and parcel between its start and end (or today). */
export async function seasonInputUse(tx: TenantTx, s: SeasonRow, until: string) {
  const r = await tx.query<{ item_id: string; item_name: string; unit: string; quantity: string; applications: number }>(
    `SELECT m.item_id, i.name AS item_name, i.unit, (-sum(m.quantity))::text AS quantity, count(*)::int AS applications
       FROM stock_movements m JOIN input_items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id
      WHERE m.tenant_id = $1 AND m.farm_id = $2 AND m.kind = 'use'
        AND m.occurred_on BETWEEN $3::date AND $4::date
        AND ($5::text IS NULL OR m.parcel_label IS NULL OR lower(m.parcel_label) = lower($5::text))
      GROUP BY m.item_id, i.name, i.unit ORDER BY i.name`,
    [tx.tenantId, s.farm_id, s.planned_start, s.ended_on ?? until, s.parcel_label],
  );
  return r.rows;
}

/** Completed and open tasks on the season's farm and parcel within its dates. */
export async function seasonTaskCounts(tx: TenantTx, s: SeasonRow, until: string) {
  const r = await tx.query<{ done: number; open: number }>(
    `SELECT count(*) FILTER (WHERE status = 'done')::int AS done, count(*) FILTER (WHERE status IN ('todo', 'in_progress'))::int AS open
       FROM farm_tasks
      WHERE tenant_id = $1 AND farm_id = $2 AND due_date BETWEEN $3::date AND $4::date
        AND ($5::text IS NULL OR parcel_label IS NULL OR lower(parcel_label) = lower($5::text))`,
    [tx.tenantId, s.farm_id, s.planned_start, s.ended_on ?? until, s.parcel_label],
  );
  return r.rows[0] ?? { done: 0, open: 0 };
}
