/**
 * Realtime updates in the browser: the API's authenticated WebSocket channel (protocol `metafarm-realtime.1`,
 * packages/domain realtime.ts) with polling as the fallback.
 *
 * - Configured at build time (NEXT_PUBLIC_REALTIME_URL, checked by next.config.ts); unset = polling only.
 * - Authentication: the session's access token travels as the `bearer.<token>` subprotocol, never in the URL, and is
 *   read afresh for every connection; signing out (no token) stops the client.
 * - One subscription per client (workspace, optional farm, event types). The last cursor is kept in memory, so a
 *   reconnect replays what was missed; `resync` (history no longer retained) asks the page to reload from the API.
 * - Reconnects with capped exponential backoff and jitter. Refusals (forbidden, not found, malformed) end the client:
 *   the page keeps polling. While not `live`, pages poll at their normal rate.
 * The client only sends `subscribe` and `ping`.
 */
import { useEffect, useRef, useState } from "react";
import { session } from "./auth";
import { realtimeUrl } from "./realtime-config";

export { realtimeConnectSource, realtimeUrl } from "./realtime-config";

export type RealtimeStatus = "off" | "connecting" | "live" | "reconnecting" | "unavailable";

export interface RealtimeSubscription {
  tenantId: string;
  farmId: string | null;
  types: string[];
}

export interface RealtimeEventMessage {
  type: string;
  id: string;
  scope: { tenantId: string; farmId: string | null };
  payload: Record<string, unknown>;
}

interface SocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

export interface RealtimeClientOptions {
  url: string;
  getToken: () => string | undefined;
  subscription: RealtimeSubscription;
  onEvent: (e: RealtimeEventMessage) => void;
  onResync: () => void;
  onStatus: (s: RealtimeStatus) => void;
  socket?: SocketFactory;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  pingMs?: number;
}

export const REALTIME_PROTOCOL = "metafarm-realtime.1";
const CURSOR = /^(0|[1-9]\d{0,18})$/;
/** Close codes and error codes after which reconnecting cannot help: the request itself is refused. */
const TERMINAL_CLOSE = new Set([4400, 4403, 4404, 4409]);
const TERMINAL_ERROR = new Set(["malformed", "unknown_type", "forbidden", "not_found", "farm_scope_required", "already_subscribed"]);

/** Numeric comparison of two cursors (decimal strings of a bigint, no leading zeros). */
export const cursorAfter = (a: string, b: string | null) => b === null || a.length > b.length || (a.length === b.length && a > b);

/** Capped exponential backoff with full jitter: attempt 1 → up to base, doubling, never above max. */
export const backoffMs = (attempt: number, base: number, max: number, random: () => number) => Math.floor(random() * Math.min(max, base * 2 ** Math.max(0, attempt - 1)));

export class RealtimeClient {
  private ws: SocketLike | null = null;
  private cursor: string | null = null;
  private attempts = 0;
  private stopped = false;
  private terminal = false;
  private retry: unknown = null;
  private ping: unknown = null;
  private status: RealtimeStatus = "off";
  private readonly o: Required<Omit<RealtimeClientOptions, "socket" | "timers" | "random">> & Pick<RealtimeClientOptions, "socket" | "timers" | "random">;

  constructor(options: RealtimeClientOptions) {
    this.o = { baseDelayMs: 1_000, maxDelayMs: 30_000, pingMs: 15_000, ...options };
  }

  private get timers() {
    return this.o.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  private setStatus(s: RealtimeStatus) {
    if (s === this.status) return;
    this.status = s;
    this.o.onStatus(s);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry !== null) this.timers.clear(this.retry);
    if (this.ping !== null) this.timers.clear(this.ping);
    this.retry = this.ping = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(1000, "done");
      } catch {
        /* already closed */
      }
    }
    this.setStatus("off");
  }

  private connect(): void {
    if (this.stopped) return;
    const token = this.o.getToken();
    if (!token) {
      // Signed out: nothing to connect with. The page keeps polling (and will itself redirect to sign-in).
      this.setStatus("unavailable");
      return;
    }
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    let ws: SocketLike;
    try {
      const make: SocketFactory = this.o.socket ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike);
      ws = make(this.o.url, [REALTIME_PROTOCOL, `bearer.${token}`]);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const s = this.o.subscription;
      ws.send(JSON.stringify({ op: "subscribe", tenantId: s.tenantId, farmId: s.farmId, types: s.types, after: this.cursor }));
      this.schedulePing();
    };
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onerror = () => undefined;
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.ping !== null) this.timers.clear(this.ping);
      this.ping = null;
      if (this.stopped) return;
      if (this.terminal || TERMINAL_CLOSE.has(e.code)) {
        this.terminal = true;
        this.setStatus("unavailable");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private schedulePing() {
    this.ping = this.timers.set(() => {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ op: "ping" }));
      if (!this.stopped && this.ws) this.schedulePing();
    }, this.o.pingMs);
  }

  private scheduleReconnect() {
    this.attempts += 1;
    this.setStatus("reconnecting");
    const delay = backoffMs(this.attempts, this.o.baseDelayMs, this.o.maxDelayMs, this.o.random ?? Math.random);
    this.retry = this.timers.set(() => {
      this.retry = null;
      this.connect();
    }, delay);
  }

  private onMessage(data: unknown) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return; // not JSON: ignored, never delivered
    }
    const cursor = typeof m.cursor === "string" && CURSOR.test(m.cursor) ? m.cursor : null;
    switch (m.op) {
      case "subscribed":
        this.attempts = 0;
        // First subscription: start from the server's newest cursor. A reconnect keeps ours, so missed events replay.
        if (this.cursor === null) this.cursor = cursor;
        this.setStatus("live");
        return;
      case "event": {
        const e = m.event as RealtimeEventMessage | undefined;
        const s = this.o.subscription;
        if (!cursor || !e || typeof e.type !== "string" || !s.types.includes(e.type) || e.scope?.tenantId !== s.tenantId || (s.farmId !== null && e.scope?.farmId !== s.farmId)) return;
        if (!cursorAfter(cursor, this.cursor)) return; // already processed
        this.cursor = cursor;
        this.o.onEvent(e);
        return;
      }
      case "resync":
        // History after our cursor is gone: continue from the server's cursor and reload the view from the API.
        this.cursor = cursor;
        this.o.onResync();
        return;
      case "error":
        if (typeof m.code === "string" && TERMINAL_ERROR.has(m.code)) this.terminal = true;
        return;
      default:
        return; // heartbeat, pong
    }
  }
}

/**
 * Subscribes while mounted; resubscribes when the workspace, farm or types change, and stops on sign-out.
 * `onChange` runs (debounced) after events and after a resync, so the page reloads its data from the API.
 * Returns the connection status ("off" when realtime is not configured).
 */
export function useRealtimeUpdates(subscription: RealtimeSubscription | null, onChange: () => void, opts: { debounceMs?: number } = {}): RealtimeStatus {
  const url = realtimeUrl();
  const [status, setStatus] = useState<RealtimeStatus>("off");
  const [token, setToken] = useState<string | undefined>(() => session.getToken());
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const debounceMs = opts.debounceMs ?? 300;

  useEffect(() => session.subscribe(() => setToken(session.getToken())), []);

  const key = subscription ? `${subscription.tenantId}|${subscription.farmId ?? "*"}|${[...subscription.types].sort().join(",")}` : null;
  const signedIn = Boolean(token);
  useEffect(() => {
    if (!url || !key || !subscription || !signedIn) {
      setStatus("off");
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => changeRef.current(), debounceMs);
    };
    const client = new RealtimeClient({ url, getToken: () => session.getToken(), subscription, onEvent: changed, onResync: changed, onStatus: setStatus });
    client.start();
    return () => {
      if (timer) clearTimeout(timer);
      client.stop();
    };
    // `subscription` is captured by key; a new object with the same scope does not resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, key, signedIn, debounceMs]);

  return status;
}
