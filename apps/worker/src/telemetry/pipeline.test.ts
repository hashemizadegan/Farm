import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cachedLookup, prepareTelemetry, type SensorInfo } from "./pipeline";

const T = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const S = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const F = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const topic = `metafarm/${T}/sensors/${S}/telemetry`;
const payload = new TextEncoder().encode(JSON.stringify({ messageId: "m1", readings: [{ metric: "rainfall", value: 0.5, unit: "cm", observedAt: "2026-10-18T08:00:00Z" }] }));
const sensors: Record<string, SensorInfo> = { [S]: { tenantId: T, farmId: F, active: true } };
const lookup = async (id: string) => sensors[id];
const now = new Date("2026-10-18T09:00:00Z");

describe("telemetry pipeline", () => {
  it("turns a message into rows with the payload hash", async () => {
    const p = await prepareTelemetry(topic, payload, { prefix: "metafarm", lookup, now });
    expect(p).toEqual({
      ok: true,
      tenantId: T,
      rejected: 0,
      rows: [
        {
          farmId: F,
          sensorId: S,
          time: "2026-10-18T08:00:00.000Z",
          metric: "rainfall",
          value: 5,
          unit: "mm",
          qualityFlags: [],
          messageId: "m1",
          payloadSha256: createHash("sha256").update(payload).digest("hex"),
        },
      ],
    });
  });

  it("refuses unknown, disabled and misplaced sensors", async () => {
    const reason = async (t: string, l = lookup) => {
      const p = await prepareTelemetry(t, payload, { prefix: "metafarm", lookup: l, now });
      return p.ok ? "ok" : p.reason;
    };
    expect(await reason(`metafarm/${T}/sensors/${F}/telemetry`)).toBe("unknown sensor");
    expect(await reason(`metafarm/${OTHER}/sensors/${S}/telemetry`)).toBe("sensor belongs to another workspace");
    expect(await reason(topic, async () => ({ tenantId: T, farmId: F, active: false }))).toBe("sensor is disabled");
    expect(await reason("metafarm/bad")).toBe("unexpected topic");
  });

  it("caches lookups for a while", async () => {
    let calls = 0;
    let clock = 0;
    const l = cachedLookup(async () => (calls++, sensors[S]), 1_000, () => clock);
    await l(S);
    await l(S);
    expect(calls).toBe(1);
    clock = 1_500;
    await l(S);
    expect(calls).toBe(2);
  });
});
