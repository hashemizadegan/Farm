import { describe, expect, it } from "vitest";
import { ObservationError, evaluateAlertRule, normaliseObservation, type AlertRule } from "./observations";

const now = new Date("2026-05-01T12:00:00Z");

describe("normaliseObservation", () => {
  it("converts units to canonical", () => {
    const o = normaliseObservation(
      { metric: "air_temperature", value: 212, unit: "fahrenheit", observedAt: "2026-05-01T11:00:00Z", provenance: "sensor-reported" },
      now,
    );
    expect(o.value).toBe(100);
    expect(o.unit).toBe("celsius");
    expect(o.originalValue).toBe(212);
  });

  it("refuses unknown units instead of guessing", () => {
    expect(() =>
      normaliseObservation(
        { metric: "rainfall", value: 1, unit: "buckets", observedAt: "2026-05-01T11:00:00Z", provenance: "user-entered" },
        now,
      ),
    ).toThrow(ObservationError);
  });

  it("flags implausible values and future timestamps", () => {
    const o = normaliseObservation(
      { metric: "relative_humidity", value: 140, unit: "percent", observedAt: "2026-05-02T00:00:00Z", provenance: "sensor-reported" },
      now,
    );
    expect(o.qualityFlags).toEqual(["timestamp_in_future", "out_of_plausible_range"]);
  });
});

describe("evaluateAlertRule", () => {
  const rule: AlertRule = {
    id: "r1",
    metric: "soil_moisture",
    comparator: "lt",
    threshold: 20,
    consecutive: 2,
    severity: "warning",
    windowSeconds: 3600,
  };
  const obs = (id: string, value: number, minutesAgo: number, flags: string[] = []) => ({
    id,
    metric: "soil_moisture" as const,
    value,
    text: null,
    unit: "percent_vwc",
    originalValue: value,
    originalUnit: "percent_vwc",
    observedAt: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
    provenance: "sensor-reported" as const,
    qualityFlags: flags,
  });

  it("fires only after N consecutive readings breach", () => {
    expect(evaluateAlertRule(rule, [obs("a", 10, 5)], now).fired).toBe(false);
    const r = evaluateAlertRule(rule, [obs("a", 10, 5), obs("b", 15, 10)], now);
    expect(r.fired).toBe(true);
    expect(r.dedupeKey).toBe("r1:a,b");
  });

  it("is deterministic regardless of input order", () => {
    const a = evaluateAlertRule(rule, [obs("a", 10, 5), obs("b", 15, 10)], now);
    const b = evaluateAlertRule(rule, [obs("b", 15, 10), obs("a", 10, 5)], now);
    expect(a).toEqual(b);
  });

  it("ignores stale and implausible readings", () => {
    expect(evaluateAlertRule(rule, [obs("a", 10, 5), obs("b", 15, 120)], now).fired).toBe(false);
    expect(evaluateAlertRule(rule, [obs("a", 10, 5), obs("b", -5, 10, ["out_of_plausible_range"])], now).fired).toBe(false);
  });
});
