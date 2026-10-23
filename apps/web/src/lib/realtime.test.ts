import { describe, expect, it } from "vitest";
import { RealtimeClient, backoffMs, cursorAfter, realtimeConnectSource, realtimeUrl, type RealtimeStatus, type SocketFactory } from "./realtime";

const T = "11111111-1111-4111-8111-111111111111";
const F = "55555555-5555-4555-8555-555555555555";

class FakeSocket {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closed = code;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(m: unknown) {
    this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function harness(token: () => string | undefined = () => "tok.en-1") {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let ids = 0;
  const statuses: RealtimeStatus[] = [];
  const events: string[] = [];
  let resyncs = 0;
  const socket: SocketFactory = (url, protocols) => {
    const s = new FakeSocket(url, protocols);
    sockets.push(s);
    return s;
  };
  const client = new RealtimeClient({
    url: "wss://api.example.org/v1/realtime",
    getToken: token,
    subscription: { tenantId: T, farmId: F, types: ["observation.recorded"] },
    onEvent: (e) => events.push(e.id),
    onResync: () => resyncs++,
    onStatus: (s) => statuses.push(s),
    socket,
    timers: {
      set: (fn, ms) => {
        const id = ++ids;
        timers.push({ fn, ms, id });
        return id;
      },
      clear: (h) => {
        const i = timers.findIndex((t) => t.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    random: () => 1,
    baseDelayMs: 1_000,
    maxDelayMs: 8_000,
  });
  const runRetry = () => {
    const t = timers.find((x) => x.ms !== 15_000);
    if (!t) throw new Error("no reconnect scheduled");
    timers.splice(timers.indexOf(t), 1);
    t.fn();
  };
  return { client, sockets, timers, statuses, events, resyncs: () => resyncs, runRetry };
}

const event = (cursor: string, over: Record<string, unknown> = {}) => ({
  op: "event",
  cursor,
  event: { type: "observation.recorded", id: `e${cursor}`, scope: { tenantId: T, farmId: F }, payload: {}, ...over },
});

describe("realtime client", () => {
  it("authenticates with a subprotocol, never in the URL, and subscribes to its scope", () => {
    const h = harness();
    h.client.start();
    const s = h.sockets[0]!;
    expect(s.url).toBe("wss://api.example.org/v1/realtime");
    expect(s.protocols).toEqual(["metafarm-realtime.1", "bearer.tok.en-1"]);
    s.open();
    expect(s.sent[0]).toEqual({ op: "subscribe", tenantId: T, farmId: F, types: ["observation.recorded"], after: null });
    s.push({ op: "subscribed", cursor: "10" });
    expect(h.statuses).toEqual(["connecting", "live"]);
  });

  it("delivers in-scope events once, in cursor order, and ignores malformed or foreign ones", () => {
    const h = harness();
    h.client.start();
    const s = h.sockets[0]!;
    s.open();
    s.push({ op: "subscribed", cursor: "10" });
    s.push(event("9")); // before the subscription point
    s.push(event("11"));
    s.push(event("11")); // repeat
    s.push("not json");
    s.push(event("12", { scope: { tenantId: "other", farmId: F } }));
    s.push(event("13", { type: "alert.raised" }));
    s.push(event("x14"));
    s.push(event("100"));
    s.push(event("99"));
    expect(h.events).toEqual(["e11", "e100"]);
  });

  it("reconnects with capped backoff and replays from the last cursor", () => {
    const h = harness();
    h.client.start();
    h.sockets[0]!.open();
    h.sockets[0]!.push({ op: "subscribed", cursor: "10" });
    h.sockets[0]!.push(event("11"));
    h.sockets[0]!.drop(1006);
    expect(h.statuses.at(-1)).toBe("reconnecting");
    const delays: number[] = [];
    for (let i = 1; i <= 5; i++) {
      delays.push(h.timers.find((t) => t.ms !== 15_000)!.ms);
      h.runRetry();
      if (i < 5) h.sockets[i]!.drop(1006);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
    const last = h.sockets[5]!;
    last.open();
    expect(last.sent[0]).toMatchObject({ op: "subscribe", after: "11" });
    last.push({ op: "subscribed", cursor: "11" });
    expect(h.statuses.at(-1)).toBe("live");
  });

  it("stops reconnecting after a refusal (the page keeps polling)", () => {
    const h = harness();
    h.client.start();
    h.sockets[0]!.open();
    h.sockets[0]!.push({ op: "error", code: "forbidden", message: "no", close: true });
    h.sockets[0]!.drop(4403);
    expect(h.statuses.at(-1)).toBe("unavailable");
    expect(h.timers.filter((t) => t.ms !== 15_000)).toHaveLength(0);
  });

  it("on resync continues from the server cursor and asks the page to reload", () => {
    const h = harness();
    h.client.start();
    const s = h.sockets[0]!;
    s.open();
    s.push({ op: "resync", reason: "cursor_expired", cursor: "500" });
    s.push({ op: "subscribed", cursor: "500" });
    expect(h.resyncs()).toBe(1);
    s.push(event("499"));
    s.push(event("501"));
    expect(h.events).toEqual(["e501"]);
  });

  it("does not connect when signed out, and stop() closes the socket and cancels timers", () => {
    const signedOut = harness(() => undefined);
    signedOut.client.start();
    expect(signedOut.sockets).toHaveLength(0);
    expect(signedOut.statuses).toEqual(["unavailable"]);

    const h = harness();
    h.client.start();
    h.sockets[0]!.open();
    h.client.stop();
    expect(h.sockets[0]!.closed).toBe(1000);
    expect(h.timers).toHaveLength(0);
    expect(h.statuses.at(-1)).toBe("off");
  });

  it("pings while connected", () => {
    const h = harness();
    h.client.start();
    h.sockets[0]!.open();
    const ping = h.timers.find((t) => t.ms === 15_000)!;
    ping.fn();
    expect(h.sockets[0]!.sent.at(-1)).toEqual({ op: "ping" });
  });
});

describe("realtime configuration helpers", () => {
  it("compares cursors numerically and caps backoff", () => {
    expect(cursorAfter("10", "9")).toBe(true);
    expect(cursorAfter("9", "10")).toBe(false);
    expect(cursorAfter("1", null)).toBe(true);
    expect(backoffMs(10, 1_000, 30_000, () => 1)).toBe(30_000);
    expect(backoffMs(1, 1_000, 30_000, () => 0.5)).toBe(500);
  });

  it("uses the channel only when the build enabled it, and allows exactly its origin in the CSP", () => {
    expect(realtimeUrl({ state: "enabled", url: "wss://api.example.org/v1/realtime" })).toBe("wss://api.example.org/v1/realtime");
    expect(realtimeUrl({ state: "disabled", url: "wss://api.example.org/v1/realtime" })).toBeUndefined();
    expect(realtimeConnectSource("wss://api.example.org/v1/realtime")).toBe("wss://api.example.org");
    expect(realtimeConnectSource("ws://localhost:4000/v1/realtime")).toBe("ws://localhost:4000");
    expect(realtimeConnectSource("https://api.example.org/v1/realtime")).toBeNull();
    expect(realtimeConnectSource("wss://*.example.org/v1/realtime")).toBeNull();
    expect(realtimeConnectSource("nonsense")).toBeNull();
    expect(realtimeConnectSource(undefined)).toBeNull();
  });
});
