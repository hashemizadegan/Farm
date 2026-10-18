import { describe, expect, it } from "vitest";
import { decodeTelemetry, parseTelemetryTopic, telemetryTopicFilter } from "./telemetry";

const T = "11111111-2222-4333-8444-555555555555";
const S = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const enc = (x: unknown) => new TextEncoder().encode(typeof x === "string" ? x : JSON.stringify(x));
const now = new Date("2026-10-18T09:00:00Z");

describe("telemetry topics", () => {
  it("reads workspace and sensor from the topic", () => {
    expect(telemetryTopicFilter("metafarm")).toBe("metafarm/+/sensors/+/telemetry");
    expect(parseTelemetryTopic(`metafarm/${T}/sensors/${S}/telemetry`, "metafarm")).toEqual({ tenantId: T, sensorId: S });
    expect(parseTelemetryTopic(`metafarm/${T.toUpperCase()}/sensors/${S}/telemetry`, "metafarm")?.tenantId).toBe(T);
    for (const bad of [`other/${T}/sensors/${S}/telemetry`, `metafarm/${T}/sensors/${S}`, `metafarm/x/sensors/${S}/telemetry`, `metafarm/${T}/devices/${S}/telemetry`, `metafarm/${T}/sensors/${S}/telemetry/extra`]) {
      expect(parseTelemetryTopic(bad, "metafarm")).toBeNull();
    }
  });
});

describe("telemetry messages", () => {
  it("normalises readings to canonical units and keeps the message id", () => {
    const r = decodeTelemetry(
      enc({
        messageId: "probe-1:42",
        readings: [
          { metric: "air_temperature", value: 68, unit: "fahrenheit", observedAt: "2026-10-18T08:59:00Z" },
          { metric: "soil_moisture", value: 0.21, unit: "fraction_vwc", observedAt: "2026-10-18T08:59:00+03:30" },
        ],
      }),
      now,
    );
    expect(r).toEqual({
      ok: true,
      messageId: "probe-1:42",
      readings: [
        { time: "2026-10-18T08:59:00.000Z", metric: "air_temperature", value: 20, unit: "celsius", qualityFlags: [] },
        { time: "2026-10-18T05:29:00.000Z", metric: "soil_moisture", value: 21, unit: "percent_vwc", qualityFlags: [] },
      ],
      rejected: [],
    });
  });

  it("rejects unknown units reading by reading, and flags implausible values", () => {
    const r = decodeTelemetry(
      enc({
        readings: [
          { metric: "rainfall", value: 3, unit: "furlongs", observedAt: "2026-10-18T08:00:00Z" },
          { metric: "relative_humidity", value: 140, unit: "percent", observedAt: "2026-10-18T08:00:00Z" },
        ],
      }),
      now,
    );
    expect(r.ok && r.rejected).toEqual([{ index: 0, reason: "cannot convert furlongs to mm" }]);
    expect(r.ok && r.readings[0]!.qualityFlags).toContain("out_of_plausible_range");
  });

  it("refuses malformed messages", () => {
    expect(decodeTelemetry(enc("not json"), now)).toEqual({ ok: false, reason: "not UTF-8 JSON" });
    expect(decodeTelemetry(Uint8Array.of(0xff, 0xfe), now).ok).toBe(false);
    expect(decodeTelemetry(enc({ readings: [] }), now).ok).toBe(false);
    expect(decodeTelemetry(enc({ readings: [{ metric: "note", value: "hi", unit: "text", observedAt: "2026-10-18T08:00:00Z" }] }), now).ok).toBe(false);
    expect(decodeTelemetry(enc({ readings: [{ metric: "ndvi", value: 0.5, unit: "index", observedAt: "2026-10-18T08:00:00Z" }], extra: 1 }), now).ok).toBe(false);
    expect(decodeTelemetry(new Uint8Array(70_000), now)).toEqual({ ok: false, reason: "payload too large" });
  });
});
