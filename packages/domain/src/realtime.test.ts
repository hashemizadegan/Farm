import { describe, expect, it } from "vitest";
import { REALTIME_LIMITS, REALTIME_PROTOCOL, bearerFromProtocols, parseRealtimeClientMessage, sameSubscription, subscriptionScopeProblem, type RealtimeSubscribe } from "./realtime";

const T = "11111111-1111-4111-8111-111111111111";
const F = "55555555-5555-4555-8555-555555555555";
const sub = (over: Record<string, unknown> = {}) => JSON.stringify({ op: "subscribe", tenantId: T, farmId: null, types: ["yield.cycle.updated"], after: null, ...over });

describe("realtime protocol: client messages", () => {
  it("accepts a subscription (types deduplicated) and pings", () => {
    const r = parseRealtimeClientMessage(sub({ types: ["alert.raised", "alert.raised"], farmId: F, after: "42" }));
    expect(r).toEqual({ ok: true, message: { op: "subscribe", tenantId: T, farmId: F, types: ["alert.raised"], after: "42" } });
    expect(parseRealtimeClientMessage('{"op":"ping"}')).toEqual({ ok: true, message: { op: "ping" } });
    expect(parseRealtimeClientMessage(new TextEncoder().encode('{"op":"ping"}'))).toMatchObject({ ok: true });
  });

  it("refuses malformed frames, unknown types, bad cursors, extra keys and anything that is not subscribe or ping", () => {
    const cases: [string | Uint8Array, string][] = [
      ["not json", "malformed"],
      [sub({ types: ["nope.type"] }), "unknown_type"],
      [sub({ types: [] }), "malformed"],
      [sub({ after: "01" }), "malformed"],
      [sub({ after: -1 }), "malformed"],
      [sub({ tenantId: "x" }), "malformed"],
      [sub({ extra: true }), "malformed"],
      [JSON.stringify({ op: "publish", type: "yield.cycle.updated" }), "malformed"],
      [JSON.stringify({ op: "transfer", to: "x", amount: "1" }), "malformed"],
      [JSON.stringify({ op: "ping", pad: "x".repeat(REALTIME_LIMITS.maxClientMessageBytes) }), "malformed"],
      [new Uint8Array([0xff, 0xfe, 0x7b]), "malformed"],
    ];
    for (const [raw, code] of cases) {
      const r = parseRealtimeClientMessage(raw);
      expect(r.ok, String(raw).slice(0, 60)).toBe(false);
      if (!r.ok) expect(r.code, String(raw).slice(0, 60)).toBe(code);
    }
  });

  it("checks the subscription scope and recognises a repeated request", () => {
    const parsed = (s: string) => (parseRealtimeClientMessage(s) as { ok: true; message: RealtimeSubscribe }).message;
    expect(subscriptionScopeProblem(parsed(sub({ farmId: F })))).toMatch(/workspace-scoped/);
    expect(subscriptionScopeProblem(parsed(sub({ farmId: F, types: ["alert.raised", "twin.snapshot.recorded"] })))).toBeNull();
    const a = parsed(sub({ types: ["alert.raised", "yield.cycle.updated"] }));
    expect(sameSubscription(a, parsed(sub({ types: ["yield.cycle.updated", "alert.raised"], after: "9" })))).toBe(true);
    expect(sameSubscription(a, parsed(sub({ types: ["alert.raised"] })))).toBe(false);
  });

  it("reads a bearer token from the subprotocol list only next to the realtime protocol", () => {
    expect(bearerFromProtocols(`${REALTIME_PROTOCOL}, bearer.abc.def-ghi_jkl`)).toBe("abc.def-ghi_jkl");
    expect(bearerFromProtocols("bearer.abc")).toBeUndefined();
    expect(bearerFromProtocols(`${REALTIME_PROTOCOL}, bearer.a b`)).toBeUndefined();
    expect(bearerFromProtocols(undefined)).toBeUndefined();
  });
});
