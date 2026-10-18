/** From one MQTT message to rows ready to store, with the checks a broker ACL alone does not give. */
import { createHash } from "node:crypto";
import type { TelemetryRow } from "@metafarm/db";
import { decodeTelemetry, parseTelemetryTopic } from "@metafarm/domain";

export interface SensorInfo {
  tenantId: string;
  farmId: string;
  active: boolean;
}

export type Prepared = { ok: true; tenantId: string; rows: TelemetryRow[]; rejected: number } | { ok: false; reason: string };

export async function prepareTelemetry(
  topic: string,
  payload: Uint8Array,
  deps: { prefix: string; lookup: (sensorId: string) => Promise<SensorInfo | undefined>; now?: Date },
): Promise<Prepared> {
  const where = parseTelemetryTopic(topic, deps.prefix);
  if (!where) return { ok: false, reason: "unexpected topic" };
  const sensor = await deps.lookup(where.sensorId);
  if (!sensor) return { ok: false, reason: "unknown sensor" };
  if (sensor.tenantId !== where.tenantId) return { ok: false, reason: "sensor belongs to another workspace" };
  if (!sensor.active) return { ok: false, reason: "sensor is disabled" };
  const decoded = decodeTelemetry(payload, deps.now);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  const payloadSha256 = createHash("sha256").update(payload).digest("hex");
  return {
    ok: true,
    tenantId: sensor.tenantId,
    rejected: decoded.rejected.length,
    rows: decoded.readings.map((r) => ({
      farmId: sensor.farmId,
      sensorId: where.sensorId,
      time: r.time,
      metric: r.metric,
      value: r.value,
      unit: r.unit,
      qualityFlags: r.qualityFlags,
      messageId: decoded.messageId,
      payloadSha256,
    })),
  };
}

/** Caches sensor lookups briefly, so a busy sensor does not hit the database for every message. */
export function cachedLookup(load: (sensorId: string) => Promise<SensorInfo | undefined>, ttlMs = 60_000, now = () => Date.now()) {
  const cache = new Map<string, { at: number; value: SensorInfo | undefined }>();
  return async (sensorId: string) => {
    const hit = cache.get(sensorId);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await load(sensorId);
    cache.set(sensorId, { at: now(), value });
    if (cache.size > 10_000) cache.delete(cache.keys().next().value!);
    return value;
  };
}
