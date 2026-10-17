import type { CreateInputItemInput, InputCategory, MovementKind, UpdateInputItemInput } from "@metafarm/domain";
import type { TenantTx } from "../tenant";

export interface InputItemRow {
  id: string;
  name: string;
  category: InputCategory;
  unit: string;
  reorder_level: string | null;
  pre_harvest_interval_days: number | null;
  re_entry_hours: number | null;
  notes: string | null;
  archived_at: string | null;
  /** Sum of movements, as text. */
  on_hand: string;
  last_movement_on: string | null;
  created_at: string;
}

const ITEM_SELECT = `
  SELECT i.id, i.name, i.category, i.unit, i.reorder_level::text AS reorder_level, i.pre_harvest_interval_days, i.re_entry_hours,
         i.notes, i.archived_at, coalesce(s.on_hand, 0)::text AS on_hand, to_char(s.last_on, 'YYYY-MM-DD') AS last_movement_on, i.created_at
    FROM input_items i
    LEFT JOIN LATERAL (
      SELECT sum(m.quantity) AS on_hand, max(m.occurred_on) AS last_on
        FROM stock_movements m WHERE m.tenant_id = i.tenant_id AND m.item_id = i.id
    ) s ON true`;

export async function listInputItems(tx: TenantTx, includeArchived = false): Promise<InputItemRow[]> {
  const r = await tx.query<InputItemRow>(
    `${ITEM_SELECT} WHERE i.tenant_id = $1 AND ($2 OR i.archived_at IS NULL) ORDER BY i.category, lower(i.name)`,
    [tx.tenantId, includeArchived],
  );
  return r.rows;
}

export async function getInputItem(tx: TenantTx, id: string): Promise<InputItemRow | undefined> {
  const r = await tx.query<InputItemRow>(`${ITEM_SELECT} WHERE i.tenant_id = $1 AND i.id = $2`, [tx.tenantId, id]);
  return r.rows[0];
}

export async function insertInputItem(tx: TenantTx, input: CreateInputItemInput, userId: string): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO input_items (tenant_id, name, category, unit, reorder_level, pre_harvest_interval_days, re_entry_hours, notes, created_by)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9) RETURNING id`,
    [
      tx.tenantId,
      input.name,
      input.category,
      input.unit,
      input.reorderLevel ?? null,
      input.preHarvestIntervalDays ?? null,
      input.reEntryHours ?? null,
      input.notes || null,
      userId,
    ],
  );
  return r.rows[0]!.id;
}

const ITEM_COLUMNS: Record<Exclude<keyof UpdateInputItemInput, "archived">, string> = {
  name: "name",
  category: "category",
  unit: "unit",
  reorderLevel: "reorder_level",
  preHarvestIntervalDays: "pre_harvest_interval_days",
  reEntryHours: "re_entry_hours",
  notes: "notes",
};

export async function updateInputItem(tx: TenantTx, id: string, input: UpdateInputItemInput): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [tx.tenantId, id];
  for (const [k, v] of Object.entries(input) as [keyof UpdateInputItemInput, unknown][]) {
    if (k === "archived") {
      sets.push(v ? "archived_at = coalesce(archived_at, now())" : "archived_at = NULL");
      continue;
    }
    params.push(v === "" ? null : v);
    sets.push(`${ITEM_COLUMNS[k]} = $${params.length}${k === "reorderLevel" ? "::numeric" : ""}`);
  }
  await tx.query(`UPDATE input_items SET ${sets.join(", ")}, updated_at = now() WHERE tenant_id = $1 AND id = $2`, params);
}

export interface MovementRow {
  id: string;
  item_id: string;
  item_name: string;
  item_unit: string;
  item_category: InputCategory;
  kind: MovementKind;
  quantity: string;
  occurred_on: string;
  farm_id: string | null;
  farm_name: string | null;
  parcel_label: string | null;
  task_id: string | null;
  task_title: string | null;
  supplier: string | null;
  lot: string | null;
  expires_on: string | null;
  cost: string | null;
  currency: string | null;
  note: string | null;
  recorded_by_name: string | null;
  created_at: string;
}

const MOVE_SELECT = `
  SELECT m.id, m.item_id, i.name AS item_name, i.unit AS item_unit, i.category AS item_category, m.kind, m.quantity::text AS quantity,
         to_char(m.occurred_on, 'YYYY-MM-DD') AS occurred_on, m.farm_id, f.name AS farm_name, m.parcel_label, m.task_id, t.title AS task_title,
         m.supplier, m.lot, to_char(m.expires_on, 'YYYY-MM-DD') AS expires_on, m.cost::text AS cost, m.currency, m.note,
         coalesce(u.display_name, u.email::text) AS recorded_by_name, m.created_at
    FROM stock_movements m
    JOIN input_items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id
    LEFT JOIN farms f ON f.tenant_id = m.tenant_id AND f.id = m.farm_id
    LEFT JOIN farm_tasks t ON t.id = m.task_id
    LEFT JOIN users u ON u.id = m.recorded_by`;

export async function insertMovement(
  tx: TenantTx,
  m: {
    itemId: string;
    kind: MovementKind;
    /** Signed. */
    quantity: string;
    occurredOn: string;
    farmId?: string | null;
    parcelLabel?: string | null;
    taskId?: string | null;
    supplier?: string | null;
    lot?: string | null;
    expiresOn?: string | null;
    cost?: string | null;
    currency?: string | null;
    note?: string | null;
    userId: string;
  },
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO stock_movements (tenant_id, item_id, kind, quantity, occurred_on, farm_id, parcel_label, task_id, supplier, lot, expires_on, cost, currency, note, recorded_by)
     VALUES ($1, $2, $3, $4::numeric, $5::date, $6, $7, $8, $9, $10, $11::date, $12::numeric, $13, $14, $15) RETURNING id`,
    [
      tx.tenantId,
      m.itemId,
      m.kind,
      m.quantity,
      m.occurredOn,
      m.farmId ?? null,
      m.parcelLabel || null,
      m.taskId ?? null,
      m.supplier || null,
      m.lot || null,
      m.expiresOn ?? null,
      m.cost ?? null,
      m.currency ?? null,
      m.note || null,
      m.userId,
    ],
  );
  return r.rows[0]!.id;
}

export async function getMovement(tx: TenantTx, id: string): Promise<MovementRow | undefined> {
  const r = await tx.query<MovementRow>(`${MOVE_SELECT} WHERE m.tenant_id = $1 AND m.id = $2`, [tx.tenantId, id]);
  return r.rows[0];
}

export async function listMovements(tx: TenantTx, f: { itemId?: string; farmId?: string; kind?: MovementKind; from?: string; to?: string; limit: number }): Promise<MovementRow[]> {
  const where = ["m.tenant_id = $1"];
  const params: unknown[] = [tx.tenantId];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (f.itemId) add("m.item_id = ?", f.itemId);
  if (f.farmId) add("m.farm_id = ?", f.farmId);
  if (f.kind) add("m.kind = ?", f.kind);
  if (f.from) add("m.occurred_on >= ?::date", f.from);
  if (f.to) add("m.occurred_on <= ?::date", f.to);
  params.push(f.limit);
  const r = await tx.query<MovementRow>(`${MOVE_SELECT} WHERE ${where.join(" AND ")} ORDER BY m.occurred_on DESC, m.created_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

export interface PhiRow {
  item_id: string;
  item_name: string;
  parcel_label: string | null;
  applied_on: string;
  pre_harvest_interval_days: number;
}

/**
 * The latest application of each product with a pre-harvest interval on a farm,
 * for the given parcel (or farm-wide applications with no parcel).
 */
export async function latestApplicationsWithPhi(tx: TenantTx, farmId: string, parcelLabel: string | null): Promise<PhiRow[]> {
  const r = await tx.query<PhiRow>(
    `SELECT DISTINCT ON (m.item_id) m.item_id, i.name AS item_name, m.parcel_label, to_char(m.occurred_on, 'YYYY-MM-DD') AS applied_on,
            i.pre_harvest_interval_days
       FROM stock_movements m JOIN input_items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id
      WHERE m.tenant_id = $1 AND m.farm_id = $2 AND m.kind = 'use' AND i.pre_harvest_interval_days > 0
        AND (m.parcel_label IS NULL OR $3::text IS NULL OR lower(m.parcel_label) = lower($3::text))
      ORDER BY m.item_id, m.occurred_on DESC`,
    [tx.tenantId, farmId, parcelLabel],
  );
  return r.rows;
}
