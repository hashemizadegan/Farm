/**
 * Observation normalisation and alert rule evaluation.
 *
 * Observations arrive from users, sensors or provider integrations in a
 * variety of units. We normalise to a canonical unit per metric and keep the
 * original value alongside. Nothing here invents readings: when a unit is
 * unknown the observation is rejected, not guessed.
 */

import type { ProvenanceLabel } from "./provenance";

export const METRICS = {
  soil_moisture: { unit: "percent_vwc", label: "Soil moisture (% VWC)" },
  air_temperature: { unit: "celsius", label: "Air temperature (°C)" },
  soil_temperature: { unit: "celsius", label: "Soil temperature (°C)" },
  rainfall: { unit: "mm", label: "Rainfall (mm)" },
  relative_humidity: { unit: "percent", label: "Relative humidity (%)" },
  ndvi: { unit: "index", label: "NDVI (index)" },
  note: { unit: "text", label: "Field note" },
} as const;

export type Metric = keyof typeof METRICS;

type Converter = (v: number) => number;
const CONVERSIONS: Record<string, Record<string, Converter>> = {
  celsius: { celsius: (v) => v, fahrenheit: (v) => ((v - 32) * 5) / 9, kelvin: (v) => v - 273.15 },
  mm: { mm: (v) => v, cm: (v) => v * 10, in: (v) => v * 25.4 },
  percent_vwc: { percent_vwc: (v) => v, fraction_vwc: (v) => v * 100 },
  percent: { percent: (v) => v, fraction: (v) => v * 100 },
  index: { index: (v) => v },
};

const PLAUSIBLE: Partial<Record<Metric, [number, number]>> = {
  soil_moisture: [0, 100],
  air_temperature: [-90, 60],
  soil_temperature: [-50, 80],
  rainfall: [0, 2000],
  relative_humidity: [0, 100],
  ndvi: [-1, 1],
};

export interface RawObservation {
  metric: string;
  value: number | string;
  unit: string;
  observedAt: string;
  provenance: ProvenanceLabel;
}

export interface NormalisedObservation {
  metric: Metric;
  value: number | null;
  text: string | null;
  unit: string;
  originalValue: number | string;
  originalUnit: string;
  observedAt: string;
  provenance: ProvenanceLabel;
  qualityFlags: string[];
}

export class ObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationError";
  }
}

export function normaliseObservation(raw: RawObservation, now = new Date()): NormalisedObservation {
  if (!(raw.metric in METRICS)) throw new ObservationError(`unknown metric: ${raw.metric}`);
  const metric = raw.metric as Metric;
  const target = METRICS[metric].unit;
  const observed = Date.parse(raw.observedAt);
  if (Number.isNaN(observed)) throw new ObservationError("observedAt must be ISO-8601");
  const flags: string[] = [];
  if (observed > now.getTime() + 5 * 60_000) flags.push("timestamp_in_future");

  if (target === "text") {
    if (typeof raw.value !== "string") throw new ObservationError("note observations take a text value");
    return {
      metric,
      value: null,
      text: raw.value.slice(0, 4_000),
      unit: "text",
      originalValue: raw.value,
      originalUnit: raw.unit,
      observedAt: new Date(observed).toISOString(),
      provenance: raw.provenance,
      qualityFlags: flags,
    };
  }

  if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) {
    throw new ObservationError("value must be a finite number");
  }
  const convert = CONVERSIONS[target]?.[raw.unit];
  if (!convert) throw new ObservationError(`cannot convert ${raw.unit} to ${target}`);
  const value = Math.round(convert(raw.value) * 1e6) / 1e6;
  const range = PLAUSIBLE[metric];
  if (range && (value < range[0] || value > range[1])) flags.push("out_of_plausible_range");

  return {
    metric,
    value,
    text: null,
    unit: target,
    originalValue: raw.value,
    originalUnit: raw.unit,
    observedAt: new Date(observed).toISOString(),
    provenance: raw.provenance,
    qualityFlags: flags,
  };
}

export type AlertComparator = "lt" | "lte" | "gt" | "gte";
export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertRule {
  id: string;
  metric: Metric;
  comparator: AlertComparator;
  threshold: number;
  /** Rule only fires when the condition holds for this many consecutive readings. */
  consecutive: number;
  severity: AlertSeverity;
  /** Ignore readings older than this window (seconds). */
  windowSeconds: number;
}

export interface AlertEvaluation {
  ruleId: string;
  fired: boolean;
  /** Deterministic key so re-running the evaluator does not create duplicate alerts. */
  dedupeKey: string | null;
  evidenceObservationIds: string[];
  message: string | null;
}

const COMPARE: Record<AlertComparator, (a: number, b: number) => boolean> = {
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
};

/**
 * Evaluates one rule against the most recent observations (any order).
 * Observations flagged out_of_plausible_range are ignored so a broken sensor
 * cannot trigger alerts on its own.
 */
export function evaluateAlertRule(
  rule: AlertRule,
  observations: readonly (NormalisedObservation & { id: string })[],
  now = new Date(),
): AlertEvaluation {
  const cutoff = now.getTime() - rule.windowSeconds * 1000;
  const relevant = observations
    .filter(
      (o) =>
        o.metric === rule.metric &&
        o.value !== null &&
        !o.qualityFlags.includes("out_of_plausible_range") &&
        Date.parse(o.observedAt) >= cutoff,
    )
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
    .slice(0, rule.consecutive);

  const none: AlertEvaluation = { ruleId: rule.id, fired: false, dedupeKey: null, evidenceObservationIds: [], message: null };
  if (relevant.length < rule.consecutive) return none;
  if (!relevant.every((o) => COMPARE[rule.comparator](o.value!, rule.threshold))) return none;

  const newest = relevant[0]!;
  return {
    ruleId: rule.id,
    fired: true,
    dedupeKey: `${rule.id}:${relevant.map((o) => o.id).sort().join(",")}`,
    evidenceObservationIds: relevant.map((o) => o.id),
    message: `${METRICS[rule.metric].label} ${rule.comparator} ${rule.threshold} for ${rule.consecutive} reading(s); latest ${newest.value} (${newest.provenance})`,
  };
}
