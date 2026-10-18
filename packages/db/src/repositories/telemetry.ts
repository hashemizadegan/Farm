import type { SystemTx, TenantTx } from "../tenant";

export interface TelemetryRow {
  farmId: string;
  sensorId: string;
  time: string;
  metric: string;
  value: number;
  unit: string;
  qualityFlags: string[];
  messageId: string | null;
  payloadSha256: string;
}

/**
 * Writes one workspace's readings in a single statement; a reading already stored (same sensor,
 * metric and time) is skipped, so redelivered messages are harmless. Marks the sensors as heard
 * from. Returns how many readings were new.
 */
export async function insertTelemetry(tx: TenantTx, rows: TelemetryRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const col = <K extends keyof TelemetryRow>(k: K) => rows.map((r) => r[k]);
  const r = await tx.query(
    `INSERT INTO iot_telemetry (time, tenant_id, farm_id, sensor_id, metric, value, unit, quality_flags, message_id, payload_sha256)
     SELECT t, $1, f, s, m, v, u, CASE WHEN q = '' THEN '{}'::text[] ELSE string_to_array(q, ',') END, mid, h
       FROM unnest($2::timestamptz[], $3::uuid[], $4::uuid[], $5::text[], $6::float8[], $7::text[], $8::text[], $9::text[], $10::text[]) AS x(t, f, s, m, v, u, q, mid, h)
     ON CONFLICT DO NOTHING`,
    [
      tx.tenantId,
      col("time"),
      col("farmId"),
      col("sensorId"),
      col("metric"),
      col("value"),
      col("unit"),
      rows.map((x) => x.qualityFlags.join(",")),
      col("messageId"),
      col("payloadSha256"),
    ],
  );
  await tx.query(`UPDATE sensors SET last_seen_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tx.tenantId, [...new Set(col("sensorId"))]]);
  return r.rowCount ?? 0;
}

/** Who a sensor belongs to, for checking a message's topic. */
export async function telemetrySensor(tx: SystemTx, sensorId: string): Promise<{ tenantId: string; farmId: string; active: boolean } | undefined> {
  const r = await tx.query<{ tenant_id: string; farm_id: string; status: string }>(`SELECT tenant_id, farm_id, status FROM sensors WHERE id = $1`, [sensorId]);
  const s = r.rows[0];
  return s ? { tenantId: s.tenant_id, farmId: s.farm_id, active: s.status === "active" } : undefined;
}
