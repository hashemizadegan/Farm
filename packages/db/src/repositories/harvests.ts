import type { AnchorStatus, CreateHarvestInput, HarvestPublicRecord } from "@metafarm/domain";
import type { SystemTx, TenantTx } from "../tenant";

export interface HarvestRow {
  id: string;
  tenant_id: string;
  farm_id: string;
  code: string;
  crop_name: string;
  parcel_label: string | null;
  harvested_on: string;
  quantity: string;
  unit: string;
  quality_grade: string | null;
  notes: string | null;
  task_id: string | null;
  season_id: string | null;
  public_record: HarvestPublicRecord;
  record_hash: string;
  anchor_status: AnchorStatus;
  anchor_attempt: number;
  anchor_chain_id: number | null;
  anchor_contract: string | null;
  anchor_tx_hash: string | null;
  anchor_block: string | null;
  anchored_at: string | null;
  anchor_error: string | null;
  voided_at: string | null;
  void_reason: string | null;
  void_anchor_status: AnchorStatus | null;
  void_tx_hash: string | null;
  recorded_by: string | null;
  recorded_by_name: string | null;
  created_at: string;
}

const SELECT = `
  SELECT h.id, h.tenant_id, h.farm_id, h.code, h.crop_name, h.parcel_label, to_char(h.harvested_on, 'YYYY-MM-DD') AS harvested_on,
         h.quantity::text AS quantity, h.unit, h.quality_grade, h.notes, h.task_id, h.season_id, h.public_record, h.record_hash,
         h.anchor_status, h.anchor_attempt, h.anchor_chain_id, h.anchor_contract, h.anchor_tx_hash, h.anchor_block::text AS anchor_block,
         h.anchored_at, h.anchor_error, h.voided_at, h.void_reason, h.void_anchor_status, h.void_tx_hash, h.recorded_by,
         coalesce(u.display_name, u.email::text) AS recorded_by_name, h.created_at
    FROM harvest_batches h
    LEFT JOIN users u ON u.id = h.recorded_by`;

export async function tenantName(tx: TenantTx): Promise<string> {
  const r = await tx.query<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [tx.tenantId]);
  return r.rows[0]?.name ?? "";
}

export async function insertHarvest(
  tx: TenantTx,
  farmId: string,
  input: CreateHarvestInput & { code: string; record: HarvestPublicRecord; hash: string; anchorStatus: AnchorStatus; userId: string; seasonId?: string | null },
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO harvest_batches (tenant_id, farm_id, code, crop_name, parcel_label, harvested_on, quantity, unit, quality_grade, notes, task_id,
                                  public_record, record_hash, anchor_status, anchor_attempt, recorded_by, created_at, season_id)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7::numeric, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17::timestamptz, $18)
     RETURNING id`,
    [
      tx.tenantId,
      farmId,
      input.code,
      input.record.crop,
      input.record.parcel,
      input.record.harvestedOn,
      input.record.quantity,
      input.record.unit,
      input.record.grade,
      input.notes || null,
      input.taskId ?? null,
      JSON.stringify(input.record),
      input.hash,
      input.anchorStatus,
      input.anchorStatus === "pending" ? 1 : 0,
      input.userId,
      input.record.recordedAt,
      input.seasonId ?? null,
    ],
  );
  return r.rows[0]!.id;
}

export async function getHarvest(tx: TenantTx, id: string, forUpdate = false): Promise<HarvestRow | undefined> {
  if (forUpdate) await tx.query(`SELECT 1 FROM harvest_batches WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tx.tenantId, id]);
  const r = await tx.query<HarvestRow>(`${SELECT} WHERE h.tenant_id = $1 AND h.id = $2`, [tx.tenantId, id]);
  return r.rows[0];
}

export async function listSeasonHarvests(tx: TenantTx, seasonId: string): Promise<HarvestRow[]> {
  const r = await tx.query<HarvestRow>(`${SELECT} WHERE h.tenant_id = $1 AND h.season_id = $2 ORDER BY h.harvested_on, h.created_at`, [tx.tenantId, seasonId]);
  return r.rows;
}

export async function listHarvests(tx: TenantTx, farmId: string, limit = 200): Promise<HarvestRow[]> {
  const r = await tx.query<HarvestRow>(`${SELECT} WHERE h.tenant_id = $1 AND h.farm_id = $2 ORDER BY h.harvested_on DESC, h.created_at DESC LIMIT $3`, [
    tx.tenantId,
    farmId,
    limit,
  ]);
  return r.rows;
}

/** Public lookup by label code; bypasses tenant scoping on purpose (the code is the capability). */
export async function getHarvestByCode(tx: SystemTx, code: string): Promise<HarvestRow | undefined> {
  const r = await tx.query<HarvestRow>(`${SELECT} WHERE h.code = $1`, [code]);
  return r.rows[0];
}

export async function voidHarvest(tx: TenantTx, id: string, reason: string, voidAnchorStatus: AnchorStatus): Promise<void> {
  await tx.query(
    `UPDATE harvest_batches SET voided_at = now(), void_reason = $3, void_anchor_status = $4 WHERE tenant_id = $1 AND id = $2 AND voided_at IS NULL`,
    [tx.tenantId, id, reason, voidAnchorStatus],
  );
}

/** Starts a new registration attempt; returns the attempt number for the job key. */
export async function restartAnchoring(tx: TenantTx, id: string, action: "record" | "void"): Promise<number> {
  const r = await tx.query<{ anchor_attempt: number }>(
    action === "record"
      ? `UPDATE harvest_batches SET anchor_status = 'pending', anchor_error = NULL, anchor_attempt = anchor_attempt + 1
          WHERE tenant_id = $1 AND id = $2 RETURNING anchor_attempt`
      : `UPDATE harvest_batches SET void_anchor_status = 'pending', anchor_error = NULL, anchor_attempt = anchor_attempt + 1
          WHERE tenant_id = $1 AND id = $2 RETURNING anchor_attempt`,
    [tx.tenantId, id],
  );
  return r.rows[0]?.anchor_attempt ?? 1;
}

export interface AnchorUpdate {
  status: AnchorStatus;
  chainId?: number;
  contract?: string;
  txHash?: string | null;
  block?: bigint | null;
  error?: string | null;
}

/** Records progress of the on-chain registration of a batch (or of its void). */
export async function setAnchorState(tx: TenantTx, id: string, action: "record" | "void", u: AnchorUpdate): Promise<void> {
  if (action === "record") {
    await tx.query(
      `UPDATE harvest_batches
          SET anchor_status = $3,
              anchor_chain_id = coalesce($4, anchor_chain_id),
              anchor_contract = coalesce($5, anchor_contract),
              anchor_tx_hash = coalesce($6, anchor_tx_hash),
              anchor_block = coalesce($7::bigint, anchor_block),
              anchored_at = CASE WHEN $3 = 'confirmed' THEN coalesce(anchored_at, now()) ELSE anchored_at END,
              anchor_error = $8
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, id, u.status, u.chainId ?? null, u.contract?.toLowerCase() ?? null, u.txHash?.toLowerCase() ?? null, u.block?.toString() ?? null, u.error?.slice(0, 500) ?? null],
    );
  } else {
    await tx.query(
      `UPDATE harvest_batches SET void_anchor_status = $3, void_tx_hash = coalesce($4, void_tx_hash), anchor_error = $5 WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, id, u.status, u.txHash?.toLowerCase() ?? null, u.error?.slice(0, 500) ?? null],
    );
  }
}

/** Harvests across the workspace (or one farm) in a date range, oldest first, with the farm name — for exports. */
export async function listHarvestsForExport(
  tx: TenantTx,
  f: { farmId?: string; from?: string; to?: string; limit: number },
): Promise<(HarvestRow & { farm_name: string })[]> {
  const r = await tx.query<HarvestRow & { farm_name: string }>(
    `SELECT x.*, f.name AS farm_name FROM (${SELECT}
       WHERE h.tenant_id = $1 AND ($2::uuid IS NULL OR h.farm_id = $2) AND ($3::date IS NULL OR h.harvested_on >= $3::date)
         AND ($4::date IS NULL OR h.harvested_on <= $4::date)) x
       JOIN farms f ON f.tenant_id = x.tenant_id AND f.id = x.farm_id
      ORDER BY x.harvested_on, x.created_at LIMIT $5`,
    [tx.tenantId, f.farmId ?? null, f.from ?? null, f.to ?? null, f.limit],
  );
  return r.rows;
}
