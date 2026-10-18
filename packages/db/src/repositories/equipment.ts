import type { CreateEquipmentInput, EquipmentKind, EquipmentStatus, MaintenancePlanInput, ServiceRecordInput, UpdateEquipmentInput } from "@metafarm/domain";
import type { TenantTx } from "../tenant";

export interface EquipmentRow {
  id: string;
  name: string;
  kind: EquipmentKind;
  make_model: string | null;
  serial: string | null;
  farm_id: string | null;
  farm_name: string | null;
  tracks_hours: boolean;
  status: EquipmentStatus;
  status_note: string | null;
  notes: string | null;
  current_hours: string | null;
  current_hours_on: string | null;
  created_at: string;
}

const SELECT = `
  SELECT e.id, e.name, e.kind, e.make_model, e.serial, e.farm_id, f.name AS farm_name, e.tracks_hours, e.status, e.status_note, e.notes,
         r.hours::text AS current_hours, to_char(r.read_on, 'YYYY-MM-DD') AS current_hours_on, e.created_at
    FROM equipment e
    LEFT JOIN farms f ON f.tenant_id = e.tenant_id AND f.id = e.farm_id
    LEFT JOIN LATERAL (
      SELECT hours, read_on FROM meter_readings m WHERE m.tenant_id = e.tenant_id AND m.equipment_id = e.id
       ORDER BY m.hours DESC, m.created_at DESC LIMIT 1
    ) r ON true`;

export async function listEquipment(tx: TenantTx): Promise<EquipmentRow[]> {
  const r = await tx.query<EquipmentRow>(
    `${SELECT} WHERE e.tenant_id = $1 ORDER BY CASE e.status WHEN 'out_of_service' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, lower(e.name)`,
    [tx.tenantId],
  );
  return r.rows;
}

export async function getEquipment(tx: TenantTx, id: string): Promise<EquipmentRow | undefined> {
  const r = await tx.query<EquipmentRow>(`${SELECT} WHERE e.tenant_id = $1 AND e.id = $2`, [tx.tenantId, id]);
  return r.rows[0];
}

export async function insertEquipment(tx: TenantTx, input: CreateEquipmentInput, userId: string): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO equipment (tenant_id, name, kind, make_model, serial, farm_id, tracks_hours, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [tx.tenantId, input.name, input.kind, input.makeModel || null, input.serial || null, input.farmId ?? null, input.tracksHours, input.notes || null, userId],
  );
  return r.rows[0]!.id;
}

const COLUMNS: Record<keyof UpdateEquipmentInput, string> = {
  name: "name",
  kind: "kind",
  makeModel: "make_model",
  serial: "serial",
  farmId: "farm_id",
  tracksHours: "tracks_hours",
  status: "status",
  statusNote: "status_note",
  notes: "notes",
};

export async function updateEquipment(tx: TenantTx, id: string, input: UpdateEquipmentInput): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [tx.tenantId, id];
  for (const [k, v] of Object.entries(input) as [keyof UpdateEquipmentInput, unknown][]) {
    params.push(v === "" ? null : v);
    sets.push(`${COLUMNS[k]} = $${params.length}`);
  }
  await tx.query(`UPDATE equipment SET ${sets.join(", ")}, updated_at = now() WHERE tenant_id = $1 AND id = $2`, params);
}

export async function insertReading(tx: TenantTx, equipmentId: string, r: { hours: string; readOn: string; note?: string | null; userId: string }) {
  await tx.query(`INSERT INTO meter_readings (tenant_id, equipment_id, hours, read_on, note, recorded_by) VALUES ($1, $2, $3::numeric, $4::date, $5, $6)`, [
    tx.tenantId,
    equipmentId,
    r.hours,
    r.readOn,
    r.note || null,
    r.userId,
  ]);
}

export async function listReadings(tx: TenantTx, equipmentId: string, limit = 30) {
  const r = await tx.query<{ id: string; hours: string; read_on: string; note: string | null; recorded_by_name: string | null }>(
    `SELECT m.id, m.hours::text AS hours, to_char(m.read_on, 'YYYY-MM-DD') AS read_on, m.note, coalesce(u.display_name, u.email::text) AS recorded_by_name
       FROM meter_readings m LEFT JOIN users u ON u.id = m.recorded_by
      WHERE m.tenant_id = $1 AND m.equipment_id = $2 ORDER BY m.read_on DESC, m.created_at DESC LIMIT $3`,
    [tx.tenantId, equipmentId, limit],
  );
  return r.rows;
}

export interface PlanRow {
  id: string;
  equipment_id: string;
  title: string;
  every_hours: number | null;
  every_days: number | null;
  last_done_on: string;
  last_done_hours: string | null;
  notes: string | null;
}

const PLAN_SELECT = `SELECT id, equipment_id, title, every_hours, every_days, to_char(last_done_on, 'YYYY-MM-DD') AS last_done_on,
                            last_done_hours::text AS last_done_hours, notes FROM maintenance_plans`;

/** Active plans; all of a workspace's when no equipment id is given (for due summaries). */
export async function listPlans(tx: TenantTx, equipmentId?: string): Promise<PlanRow[]> {
  const r = await tx.query<PlanRow>(
    `${PLAN_SELECT} WHERE tenant_id = $1 AND archived_at IS NULL AND ($2::uuid IS NULL OR equipment_id = $2) ORDER BY title`,
    [tx.tenantId, equipmentId ?? null],
  );
  return r.rows;
}

export async function getPlan(tx: TenantTx, equipmentId: string, planId: string): Promise<PlanRow | undefined> {
  const r = await tx.query<PlanRow>(`${PLAN_SELECT} WHERE tenant_id = $1 AND equipment_id = $2 AND id = $3 AND archived_at IS NULL`, [
    tx.tenantId,
    equipmentId,
    planId,
  ]);
  return r.rows[0];
}

export async function insertPlan(tx: TenantTx, equipmentId: string, p: MaintenancePlanInput): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO maintenance_plans (tenant_id, equipment_id, title, every_hours, every_days, last_done_on, last_done_hours, notes)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7::numeric, $8) RETURNING id`,
    [tx.tenantId, equipmentId, p.title, p.everyHours ?? null, p.everyDays ?? null, p.lastDoneOn, p.lastDoneHours ?? null, p.notes || null],
  );
  return r.rows[0]!.id;
}

export async function archivePlan(tx: TenantTx, equipmentId: string, planId: string) {
  await tx.query(`UPDATE maintenance_plans SET archived_at = now() WHERE tenant_id = $1 AND equipment_id = $2 AND id = $3`, [tx.tenantId, equipmentId, planId]);
}

export async function insertService(tx: TenantTx, equipmentId: string, s: ServiceRecordInput & { userId: string }) {
  await tx.query(
    `INSERT INTO service_records (tenant_id, equipment_id, plan_id, done_on, hours, description, cost, currency, recorded_by)
     VALUES ($1, $2, $3, $4::date, $5::numeric, $6, $7::numeric, $8, $9)`,
    [tx.tenantId, equipmentId, s.planId ?? null, s.doneOn, s.hours ?? null, s.description, s.cost ?? null, s.currency ?? null, s.userId],
  );
  if (s.planId) {
    // The plan restarts from this service (never moves backwards if an older service is entered late).
    await tx.query(
      `UPDATE maintenance_plans
          SET last_done_on = GREATEST(last_done_on, $4::date),
              last_done_hours = CASE WHEN $5::numeric IS NOT NULL AND (last_done_hours IS NULL OR $5::numeric > last_done_hours) THEN $5::numeric ELSE last_done_hours END
        WHERE tenant_id = $1 AND equipment_id = $2 AND id = $3`,
      [tx.tenantId, equipmentId, s.planId, s.doneOn, s.hours ?? null],
    );
  }
}

export async function listServices(tx: TenantTx, equipmentId: string, limit = 50) {
  const r = await tx.query<{
    id: string;
    plan_title: string | null;
    done_on: string;
    hours: string | null;
    description: string;
    cost: string | null;
    currency: string | null;
    recorded_by_name: string | null;
  }>(
    `SELECT s.id, p.title AS plan_title, to_char(s.done_on, 'YYYY-MM-DD') AS done_on, s.hours::text AS hours, s.description, s.cost::text AS cost, s.currency,
            coalesce(u.display_name, u.email::text) AS recorded_by_name
       FROM service_records s
       LEFT JOIN maintenance_plans p ON p.tenant_id = s.tenant_id AND p.id = s.plan_id
       LEFT JOIN users u ON u.id = s.recorded_by
      WHERE s.tenant_id = $1 AND s.equipment_id = $2 ORDER BY s.done_on DESC, s.created_at DESC LIMIT $3`,
    [tx.tenantId, equipmentId, limit],
  );
  return r.rows;
}
