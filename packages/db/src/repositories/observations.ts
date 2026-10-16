import type { AlertRule, NormalisedObservation, ProvenanceLabel } from "@metafarm/domain";
import type { TenantTx } from "../tenant";

export async function insertRawObservation(
  tx: TenantTx,
  input: { farmId: string; sensorId?: string; payload: unknown; provenance: ProvenanceLabel; userId?: string },
): Promise<{ id: string }> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO raw_observations (tenant_id, farm_id, sensor_id, payload, provenance_label, received_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id`,
    [tx.tenantId, input.farmId, input.sensorId ?? null, JSON.stringify(input.payload), input.provenance, input.userId ?? null],
  );
  return r.rows[0]!;
}

export async function getRawObservation(tx: TenantTx, id: string) {
  const r = await tx.query<{
    id: string;
    farm_id: string;
    sensor_id: string | null;
    payload: Record<string, unknown>;
    provenance_label: ProvenanceLabel;
    status: string;
  }>(
    `SELECT id, farm_id, sensor_id, payload, provenance_label, status FROM raw_observations WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, id],
  );
  return r.rows[0];
}

export async function markRawObservation(tx: TenantTx, id: string, status: "normalized" | "rejected", error?: string) {
  await tx.query(`UPDATE raw_observations SET status = $3, error = $4 WHERE tenant_id = $1 AND id = $2`, [
    tx.tenantId,
    id,
    status,
    error ?? null,
  ]);
}

/** Idempotent on raw_id: re-running normalisation for the same raw row is a no-op. */
export async function insertObservation(
  tx: TenantTx,
  farmId: string,
  rawId: string,
  sensorId: string | null,
  o: NormalisedObservation,
): Promise<{ id: string; inserted: boolean }> {
  const r = await tx.query<{ id: string; inserted: boolean }>(
    `INSERT INTO observations
       (tenant_id, farm_id, sensor_id, raw_id, metric, value, text_value, unit, original_value, original_unit,
        observed_at, provenance_label, quality_flags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
     ON CONFLICT (raw_id) DO UPDATE SET raw_id = EXCLUDED.raw_id
     RETURNING id, (xmax = 0) AS inserted`,
    [
      tx.tenantId,
      farmId,
      sensorId,
      rawId,
      o.metric,
      o.value,
      o.text,
      o.unit,
      JSON.stringify(o.originalValue),
      o.originalUnit,
      o.observedAt,
      o.provenance,
      o.qualityFlags,
    ],
  );
  return r.rows[0]!;
}

export interface ObservationRow {
  id: string;
  farm_id: string;
  sensor_id: string | null;
  metric: string;
  value: number | null;
  text_value: string | null;
  unit: string;
  observed_at: string;
  provenance_label: ProvenanceLabel;
  quality_flags: string[];
}

export async function listObservations(
  tx: TenantTx,
  farmId: string,
  opts: { metric?: string; since?: string; limit: number },
): Promise<ObservationRow[]> {
  const r = await tx.query<ObservationRow>(
    `SELECT id, farm_id, sensor_id, metric, value, text_value, unit, observed_at, provenance_label, quality_flags
       FROM observations
      WHERE tenant_id = $1 AND farm_id = $2
        AND ($3::text IS NULL OR metric = $3)
        AND ($4::timestamptz IS NULL OR observed_at >= $4)
      ORDER BY observed_at DESC LIMIT $5`,
    [tx.tenantId, farmId, opts.metric ?? null, opts.since ?? null, opts.limit],
  );
  return r.rows;
}

export async function listEnabledRules(tx: TenantTx, farmId: string): Promise<AlertRule[]> {
  const r = await tx.query<{
    id: string;
    metric: AlertRule["metric"];
    comparator: AlertRule["comparator"];
    threshold: number;
    consecutive: number;
    severity: AlertRule["severity"];
    window_seconds: number;
  }>(
    `SELECT id, metric, comparator, threshold, consecutive, severity, window_seconds
       FROM alert_rules WHERE tenant_id = $1 AND farm_id = $2 AND enabled`,
    [tx.tenantId, farmId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    metric: x.metric,
    comparator: x.comparator,
    threshold: x.threshold,
    consecutive: x.consecutive,
    severity: x.severity,
    windowSeconds: x.window_seconds,
  }));
}

/** Insert an alert once per dedupe key. Returns whether a new alert was created. */
export async function insertAlertOnce(
  tx: TenantTx,
  a: { farmId: string; ruleId: string; severity: string; message: string; dedupeKey: string; evidence: string[] },
): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO alerts (tenant_id, farm_id, rule_id, severity, message, dedupe_key, evidence_observation_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
    [tx.tenantId, a.farmId, a.ruleId, a.severity, a.message, a.dedupeKey, a.evidence],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface AlertRow {
  id: string;
  farm_id: string;
  rule_id: string | null;
  severity: "info" | "warning" | "critical";
  message: string;
  status: "open" | "acknowledged" | "resolved";
  evidence_observation_ids: string[];
  acknowledged_at: string | null;
  created_at: string;
}

export async function listAlerts(tx: TenantTx, farmId: string, status?: AlertRow["status"]): Promise<AlertRow[]> {
  const r = await tx.query<AlertRow>(
    `SELECT id, farm_id, rule_id, severity, message, status, evidence_observation_ids, acknowledged_at, created_at
       FROM alerts WHERE tenant_id = $1 AND farm_id = $2 AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC LIMIT 200`,
    [tx.tenantId, farmId, status ?? null],
  );
  return r.rows;
}

export async function acknowledgeAlert(tx: TenantTx, farmId: string, alertId: string, userId: string, note?: string) {
  const r = await tx.query<AlertRow>(
    `UPDATE alerts SET status = 'acknowledged', acknowledged_by = $4, acknowledged_at = now(), ack_note = $5
      WHERE tenant_id = $1 AND farm_id = $2 AND id = $3 AND status = 'open'
      RETURNING id, farm_id, rule_id, severity, message, status, evidence_observation_ids, acknowledged_at, created_at`,
    [tx.tenantId, farmId, alertId, userId, note ?? null],
  );
  return r.rows[0];
}
