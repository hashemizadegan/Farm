import { describe, expect, it } from "vitest";
import { alertRuleSchema, ingestSchema, sensorIdFromToken, sensorState, sensorTokenPrefix } from "./sensors";

describe("sensor tokens", () => {
  const id = "0b3c5d7e-9f1a-4b4c-8d8e-0f1a2b3c4d5e";
  it("round-trips the sensor id and rejects anything else", () => {
    const token = `${sensorTokenPrefix(id)}${"A".repeat(43)}`;
    expect(sensorIdFromToken(token)).toBe(id);
    expect(sensorIdFromToken(token.slice(0, -1))).toBeUndefined();
    expect(sensorIdFromToken(`Bearer ${token}`)).toBeUndefined();
  });
});

describe("ingest payload", () => {
  it("accepts numeric readings only, in bounded batches", () => {
    const r = { metric: "soil_moisture", value: 23.4, unit: "percent_vwc", observedAt: "2026-10-18T06:00:00Z" };
    expect(ingestSchema.safeParse({ readings: [r] }).success).toBe(true);
    expect(ingestSchema.safeParse({ readings: [{ ...r, metric: "note" }] }).success).toBe(false);
    expect(ingestSchema.safeParse({ readings: [] }).success).toBe(false);
    expect(ingestSchema.safeParse({ readings: Array(201).fill(r) }).success).toBe(false);
    expect(ingestSchema.safeParse({ readings: [{ ...r, value: Number.NaN }] }).success).toBe(false);
  });
});

describe("sensor state", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  it("tells waiting, online, silent and disabled apart", () => {
    expect(sensorState({ status: "active", lastSeenAt: null, silentAfterMinutes: 60 }, now)).toBe("waiting");
    expect(sensorState({ status: "active", lastSeenAt: "2026-10-18T11:30:00Z", silentAfterMinutes: 60 }, now)).toBe("online");
    expect(sensorState({ status: "active", lastSeenAt: "2026-10-18T10:30:00Z", silentAfterMinutes: 60 }, now)).toBe("silent");
    expect(sensorState({ status: "disabled", lastSeenAt: null, silentAfterMinutes: 60 }, now)).toBe("disabled");
  });
});

describe("alert rules", () => {
  it("defaults to one reading in a 60-minute window", () => {
    expect(alertRuleSchema.parse({ metric: "soil_moisture", comparator: "lt", threshold: 15, severity: "warning" })).toMatchObject({ consecutive: 1, windowMinutes: 60 });
  });
});
