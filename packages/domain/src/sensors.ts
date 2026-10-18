/**
 * Live sensors. Each device gets its own secret token, shown once; only its
 * SHA-256 is stored. Devices send readings over HTTPS with that token, and the
 * readings go through the same normalisation as everything else, labelled
 * `sensor-reported`.
 */
import { z } from "zod";
import { METRICS } from "./observations";

export const SENSOR_KINDS = ["soil-moisture", "weather-station", "temperature", "rain-gauge", "humidity", "multi", "other"] as const;
export type SensorKind = (typeof SENSOR_KINDS)[number];

/** Token layout: "mfs_" + sensor id (32 hex) + "_" + 43 url-safe characters of randomness. */
export const SENSOR_TOKEN = /^mfs_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

export function sensorIdFromToken(token: string): string | undefined {
  const m = SENSOR_TOKEN.exec(token.trim());
  if (!m) return undefined;
  const h = m[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function sensorTokenPrefix(sensorId: string): string {
  return `mfs_${sensorId.replace(/-/g, "")}_`;
}

export const createSensorSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(SENSOR_KINDS),
    parcelLabel: z.string().trim().max(80).nullable().optional(),
    location: z.object({ lon: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) }).nullable().optional(),
    silentAfterMinutes: z.number().int().min(5).max(10_080).default(180),
  })
  .strict();
export type CreateSensorInput = z.infer<typeof createSensorSchema>;

export const updateSensorSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    parcelLabel: z.string().trim().max(80).nullable(),
    status: z.enum(["active", "disabled"]),
    silentAfterMinutes: z.number().int().min(5).max(10_080),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "nothing to change");
export type UpdateSensorInput = z.infer<typeof updateSensorSchema>;

const NUMERIC_METRICS = Object.keys(METRICS).filter((m) => m !== "note") as [string, ...string[]];

/** What a device sends. Up to 200 readings per request, e.g. a buffered batch after a network outage. */
export const ingestSchema = z
  .object({
    readings: z
      .array(
        z
          .object({
            metric: z.enum(NUMERIC_METRICS),
            value: z.number().finite(),
            unit: z.string().min(1).max(32),
            observedAt: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type IngestInput = z.infer<typeof ingestSchema>;

export const ALERT_COMPARATORS = ["lt", "lte", "gt", "gte"] as const;

export const alertRuleSchema = z
  .object({
    metric: z.enum(NUMERIC_METRICS),
    comparator: z.enum(ALERT_COMPARATORS),
    /** In the metric's canonical unit (e.g. % VWC, °C, mm). */
    threshold: z.number().finite(),
    consecutive: z.number().int().min(1).max(50).default(1),
    severity: z.enum(["info", "warning", "critical"]),
    windowMinutes: z.number().int().min(1).max(43_200).default(60),
  })
  .strict();
export type AlertRuleInput = z.infer<typeof alertRuleSchema>;

/** A sensor is silent when it has not reported within its allowance. Never-seen sensors are "waiting", not silent. */
export function sensorState(s: { status: string; lastSeenAt: string | null; silentAfterMinutes: number }, now: Date): "disabled" | "waiting" | "online" | "silent" {
  if (s.status !== "active") return "disabled";
  if (!s.lastSeenAt) return "waiting";
  return now.getTime() - Date.parse(s.lastSeenAt) > s.silentAfterMinutes * 60_000 ? "silent" : "online";
}
