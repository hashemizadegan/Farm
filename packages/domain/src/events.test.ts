import { describe, expect, it } from "vitest";
import { EVENT_ENVELOPE_SCHEME, EventEnvelopeError, authorizeEvent, parseEventEnvelope } from "./events";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FARM = "33333333-3333-4333-8333-333333333333";
const base = {
  scheme: EVENT_ENVELOPE_SCHEME,
  type: "yield.cycle.updated",
  schemaVersion: 1,
  id: "44444444-4444-4444-8444-444444444444",
  scope: { tenantId: T, farmId: null },
  occurredAt: "2026-10-22T19:00:00.000Z",
  correlationId: "req-1",
  payload: { cycleId: "55555555-5555-4555-8555-555555555555", status: "published", simulation: true },
};
const snapshot = { ...base, type: "twin.snapshot.recorded", scope: { tenantId: T, farmId: FARM }, payload: { commitmentId: "66666666-6666-4666-8666-666666666666", sha256: "ab".repeat(32) } };
const code = (input: unknown) => {
  try {
    parseEventEnvelope(input);
  } catch (e) {
    if (e instanceof EventEnvelopeError) return e.code;
    throw e;
  }
  return "valid";
};

describe("event envelope metafarm-event/1", () => {
  it("accepts well-formed workspace- and farm-scoped events", () => {
    expect(parseEventEnvelope(base).type).toBe("yield.cycle.updated");
    expect(parseEventEnvelope(snapshot).scope.farmId).toBe(FARM);
    expect(code({ ...base, correlationId: null })).toBe("valid");
  });

  it("refuses malformed envelopes and payloads, unknown types, other versions and wrong scopes", () => {
    expect(code({ ...base, scheme: "other/1" })).toBe("malformed");
    expect(code({ ...base, extra: 1 })).toBe("malformed");
    expect(code({ ...base, id: "not-a-uuid" })).toBe("malformed");
    expect(code({ ...base, occurredAt: "2026-10-22 19:00" })).toBe("malformed");
    expect(code({ ...base, correlationId: "has spaces" })).toBe("malformed");
    expect(code({ ...base, payload: { ...base.payload, amount: 1 } })).toBe("malformed");
    expect(code({ ...base, payload: { cycleId: "x", status: "published", simulation: true } })).toBe("malformed");
    expect(code({ ...base, type: "wallet.drained" })).toBe("unknown_type");
    expect(code({ ...base, schemaVersion: 2 })).toBe("unsupported_version");
    expect(code({ ...base, scope: { tenantId: T, farmId: FARM } })).toBe("scope_mismatch");
    expect(code({ ...snapshot, scope: { tenantId: T, farmId: null } })).toBe("scope_mismatch");
  });

  it("authorizes by membership, the type's permission and the farm's workspace (resolved by the caller)", () => {
    const yieldEvent = parseEventEnvelope(base);
    const farmEvent = parseEventEnvelope(snapshot);
    expect(authorizeEvent(yieldEvent, { roles: { [T]: "owner" } }, false)).toEqual({ allow: true });
    expect(authorizeEvent(yieldEvent, { roles: { [OTHER]: "owner" } }, false)).toEqual({ allow: false, reason: "not_a_member" });
    // A field worker cannot read yield cycles, so receives no yield events.
    expect(authorizeEvent(yieldEvent, { roles: { [T]: "worker" } }, false)).toEqual({ allow: false, reason: "missing_permission" });
    expect(authorizeEvent(farmEvent, { roles: { [T]: "worker" } }, true)).toEqual({ allow: true });
    expect(authorizeEvent(farmEvent, { roles: { [T]: "owner" } }, false)).toEqual({ allow: false, reason: "farm_outside_workspace" });
  });
});
