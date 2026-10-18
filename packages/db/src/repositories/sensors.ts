import type { AlertRuleInput, CreateSensorInput, UpdateSensorInput } from "@metafarm/domain";
import type { SystemTx, TenantTx } from "../tenant";

export interface SensorRow {
  id: string;
  farm_id: string;
  name: string;
  kind: string;
  parcel_label: string | null;
  lon: number | null;
  lat: number | null;
  status: "active" | "disabled";
  last_seen_at: string | null;
  silent_after_minutes: number;
  credential_rotated_at: string | null;
  created_at: string;
  latest: { metric: string; value: number | null; unit: string; observed_at: string }[];
}

const SELECT = `
  SELECT s.id, s.farm_id, s.name, s.kind, s.parcel_label, ST_X(s.location) AS lon, ST_Y(s.location) AS lat, s.status, s.last_seen_at,
         s.silent_after_minutes, s.credential_rotated_at, s.created_at,
         coalesce((
           SELECT json_agg(json_build_object('metric', o.metric, 'value', o.value, 'unit', o.unit, 'observed_at', o.observed_at) ORDER BY o.metric)
             FROM (SELECT DISTINCT ON (metric) metric, value, unit, observed_at FROM observations
                    WHERE tenant_id = s.tenant_id AND sensor_id = s.id ORDER BY metric, observed_at DESC) o
         ), '[]'::json) AS latest
    FROM sensors s`;

export async function listSensors(tx: TenantTx, farmId: string): Promise<SensorRow[]> {
  const r = await tx.query<SensorRow>(`${SELECT} WHERE s.tenant_id = $1 AND s.farm_id = $2 ORDER BY lower(s.name)`, [tx.tenantId, farmId]);
  return r.rows;
}

export async function getSensor(tx: TenantTx, farmId: string, id: string): Promise<SensorRow | undefined> {
  const r = await tx.query<SensorRow>(`${SELECT} WHERE s.tenant_id = $1 AND s.farm_id = $2 AND s.id = $3`, [tx.tenantId, farmId, id]);
  return r.rows[0];
}

export async function insertSensor(tx: TenantTx, farmId: string, id: string, input: CreateSensorInput, credentialHash: string, userId: string) {
  await tx.query(
    `INSERT INTO sensors (id, tenant_id, farm_id, name, kind, parcel_label, location, silent_after_minutes, credential_hash, credential_rotated_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($7::float8, $8::float8), 4326) END, $9, $10, now(), $11)`,
    [id, tx.tenantId, farmId, input.name, input.kind, input.parcelLabel || null, input.location?.lon ?? null, input.location?.lat ?? null, input.silentAfterMinutes, credentialHash, userId],
  );
}

const COLUMNS: Record<keyof UpdateSensorInput, string> = { name: "name", parcelLabel: "parcel_label", status: "status", silentAfterMinutes: "silent_after_minutes" };

export async function updateSensor(tx: TenantTx, id: string, input: UpdateSensorInput) {
  const sets: string[] = [];
  const params: unknown[] = [tx.tenantId, id];
  for (const [k, v] of Object.entries(input) as [keyof UpdateSensorInput, unknown][]) {
    params.push(v === "" ? null : v);
    sets.push(`${COLUMNS[k]} = $${params.length}`);
  }
  await tx.query(`UPDATE sensors SET ${sets.join(", ")} WHERE tenant_id = $1 AND id = $2`, params);
}

export async function setSensorCredential(tx: TenantTx, id: string, credentialHash: string) {
  await tx.query(`UPDATE sensors SET credential_hash = $3, credential_rotated_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id, credentialHash]);
}

/** Device authentication happens before any tenant is known, so this lookup is system-scoped by sensor id. */
export async function getSensorForIngest(tx: SystemTx, id: string) {
  const r = await tx.query<{ id: string; tenant_id: string; farm_id: string; status: string; credential_hash: string | null }>(
    `SELECT id, tenant_id, farm_id, status, credential_hash FROM sensors WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

export async function touchSensor(tx: TenantTx, id: string) {
  await tx.query(`UPDATE sensors SET last_seen_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id]);
}

/** Active sensors that have reported before but not within their allowance (all tenants; for the sweep). */
export async function silentSensors(tx: SystemTx) {
  const r = await tx.query<{ id: string; tenant_id: string; farm_id: string; name: string; last_seen_at: string }>(
    `SELECT id, tenant_id, farm_id, name, last_seen_at FROM sensors
      WHERE status = 'active' AND last_seen_at IS NOT NULL AND last_seen_at < now() - make_interval(mins => silent_after_minutes)
      LIMIT 1000`,
  );
  return r.rows;
}

export interface AlertRuleRow {
  id: string;
  metric: string;
  comparator: "lt" | "lte" | "gt" | "gte";
  threshold: number;
  consecutive: number;
  severity: "info" | "warning" | "critical";
  window_seconds: number;
  enabled: boolean;
  created_at: string;
}

export async function listAlertRules(tx: TenantTx, farmId: string): Promise<AlertRuleRow[]> {
  const r = await tx.query<AlertRuleRow>(
    `SELECT id, metric, comparator, threshold, consecutive, severity, window_seconds, enabled, created_at
       FROM alert_rules WHERE tenant_id = $1 AND farm_id = $2 ORDER BY enabled DESC, metric, created_at`,
    [tx.tenantId, farmId],
  );
  return r.rows;
}

export async function insertAlertRule(tx: TenantTx, farmId: string, input: AlertRuleInput, userId: string): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO alert_rules (tenant_id, farm_id, metric, comparator, threshold, consecutive, severity, window_seconds, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [tx.tenantId, farmId, input.metric, input.comparator, input.threshold, input.consecutive, input.severity, input.windowMinutes * 60, userId],
  );
  return r.rows[0]!.id;
}

export async function setAlertRuleEnabled(tx: TenantTx, farmId: string, id: string, enabled: boolean): Promise<boolean> {
  const r = await tx.query(`UPDATE alert_rules SET enabled = $4 WHERE tenant_id = $1 AND farm_id = $2 AND id = $3`, [tx.tenantId, farmId, id, enabled]);
  return (r.rowCount ?? 0) > 0;
}
