import { describe, expect, it } from "vitest";
import { IntegrationEventRefusal, findWorkspaceKey, parseIntegrationEvent, registerIntegrationSchema } from "./integrations";

const S = "33333333-3333-4333-8333-333333333333";
const F = "55555555-5555-4555-8555-555555555555";
const reading = { metric: "soil_moisture", value: 0.2, unit: "fraction_vwc", observedAt: "2026-10-23T01:00:00Z" };
const readings = (over: Record<string, unknown> = {}) => ({ scheme: "metafarm-integration-event/1", id: "evt-1", type: "sensor.readings", sensorId: S, readings: [reading], ...over });
const refusal = (body: unknown, allowed = ["sensor.readings", "observation.reported"]) => {
  try {
    parseIntegrationEvent(body, allowed);
  } catch (e) {
    if (e instanceof IntegrationEventRefusal) return e.code;
    throw e;
  }
  return "accepted";
};

describe("integration events (metafarm-integration-event/1)", () => {
  it("accepts sensor readings and observations, exactly", () => {
    expect(refusal(readings())).toBe("accepted");
    expect(refusal({ scheme: "metafarm-integration-event/1", id: "obs:1", type: "observation.reported", farmId: F, observations: [{ ...reading, metric: "note", value: "dry patch" }] })).toBe("accepted");
  });

  it("refuses any workspace identity in the payload, wherever it is, before anything else", () => {
    for (const body of [readings({ tenantId: F }), readings({ readings: [{ ...reading, workspace_id: F }] }), { nested: { deeper: [{ TenantID: "x" }] } }]) {
      expect(refusal(body)).toBe("workspace_in_payload");
    }
    expect(findWorkspaceKey(readings())).toBeNull();
  });

  it("refuses malformed events and types the integration may not send", () => {
    expect(refusal(readings({ scheme: "other/1" }))).toBe("malformed");
    expect(refusal(readings({ id: "has space" }))).toBe("malformed");
    expect(refusal(readings({ readings: [{ ...reading, metric: "note" }] }))).toBe("malformed");
    expect(refusal(readings({ extra: 1 }))).toBe("malformed");
    expect(refusal(readings(), ["observation.reported"])).toBe("event_type_not_allowed");
  });

  it("registration: event types must belong to the integration's kind", () => {
    expect(registerIntegrationSchema.safeParse({ kind: "sensor_feed", provider: "acme-probes", name: "Probes", allowedEventTypes: ["sensor.readings"] }).success).toBe(true);
    expect(registerIntegrationSchema.safeParse({ kind: "sensor_feed", provider: "acme-probes", name: "Probes", allowedEventTypes: ["observation.reported"] }).success).toBe(false);
    expect(registerIntegrationSchema.safeParse({ kind: "sensor_feed", provider: "Acme", name: "Probes", allowedEventTypes: ["sensor.readings"] }).success).toBe(false);
  });
});
