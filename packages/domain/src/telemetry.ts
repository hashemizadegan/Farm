/**
 * MQTT telemetry. Devices publish to `{prefix}/{tenantId}/sensors/{sensorId}/telemetry` (QoS 1) the
 * same readings the HTTPS ingestion takes, plus an optional message id. The broker authenticates
 * each device and its ACL limits it to its own topic; the consumer still checks that the sensor
 * exists, is active and belongs to the workspace in the topic.
 */
import { z } from "zod";
import { normaliseObservation } from "./observations";
import { ingestSchema } from "./sensors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const telemetryTopicFilter = (prefix: string) => `${prefix}/+/sensors/+/telemetry`;

export function parseTelemetryTopic(topic: string, prefix: string): { tenantId: string; sensorId: string } | null {
  const parts = topic.split("/");
  if (parts.length !== 5 || parts[0] !== prefix || parts[2] !== "sensors" || parts[4] !== "telemetry") return null;
  const [, tenantId, , sensorId] = parts as [string, string, string, string, string];
  return UUID.test(tenantId) && UUID.test(sensorId) ? { tenantId: tenantId.toLowerCase(), sensorId: sensorId.toLowerCase() } : null;
}

export const telemetryMessageSchema = z
  .object({
    /** The device's own id for this message; kept for tracing and duplicate detection. */
    messageId: z.string().min(1).max(128).optional(),
    readings: ingestSchema.shape.readings,
  })
  .strict();

/** Largest payload accepted (a full message of 200 readings is well under this). */
export const MAX_TELEMETRY_BYTES = 64 * 1024;

export interface TelemetryReading {
  time: string;
  metric: string;
  /** In the metric's canonical unit. */
  value: number;
  unit: string;
  qualityFlags: string[];
}

export type DecodedTelemetry =
  | { ok: true; messageId: string | null; readings: TelemetryReading[]; rejected: { index: number; reason: string }[] }
  | { ok: false; reason: string };

/** Parses and normalises one message. Readings in unknown units are rejected one by one, never guessed. */
export function decodeTelemetry(payload: Uint8Array, now = new Date()): DecodedTelemetry {
  if (payload.length > MAX_TELEMETRY_BYTES) return { ok: false, reason: "payload too large" };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    return { ok: false, reason: "not UTF-8 JSON" };
  }
  const parsed = telemetryMessageSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? "invalid message" };
  const readings: TelemetryReading[] = [];
  const rejected: { index: number; reason: string }[] = [];
  parsed.data.readings.forEach((r, index) => {
    try {
      const n = normaliseObservation({ ...r, provenance: "sensor-reported" }, now);
      readings.push({ time: n.observedAt, metric: n.metric, value: n.value!, unit: n.unit, qualityFlags: n.qualityFlags });
    } catch (err) {
      rejected.push({ index, reason: (err as Error).message });
    }
  });
  return { ok: true, messageId: parsed.data.messageId ?? null, readings, rejected };
}
