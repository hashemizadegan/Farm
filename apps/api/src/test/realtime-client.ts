/**
 * Test clients for the realtime channel against a listening app: Node's built-in WebSocket (browser-like: the token
 * travels as the `bearer.<token>` subprotocol) and a raw HTTP upgrade (header authentication, status codes).
 */
import { randomBytes } from "node:crypto";
import http from "node:http";

type Msg = Record<string, unknown> & { op: string };

interface BrowserLikeSocket {
  readyState: number;
  protocol: string;
  onopen: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
const WS = (globalThis as unknown as { WebSocket: new (url: string, protocols?: string[]) => BrowserLikeSocket }).WebSocket;

export interface RealtimeTestClient {
  messages: Msg[];
  protocol: string;
  send(m: unknown): void;
  sendRaw(s: string): void;
  /** The first message (from `from` on) matching `pred`; rejects after `ms`. */
  next(pred: (m: Msg) => boolean, ms?: number, from?: number): Promise<Msg>;
  events(): Msg[];
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

export function connectRealtime(port: number, token: string, opts: { ping?: boolean } = {}): Promise<RealtimeTestClient> {
  const ws = new WS(`ws://127.0.0.1:${port}/v1/realtime`, ["metafarm-realtime.1", `bearer.${token}`]);
  const messages: Msg[] = [];
  let pinger: NodeJS.Timeout | undefined;
  let lastClose = "open";
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (e) => {
      if (pinger) clearInterval(pinger);
      lastClose = `closed ${e.code} ${e.reason}`;
      resolve({ code: e.code, reason: e.reason });
    };
  });
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)) as Msg);
  const client: RealtimeTestClient = {
    messages,
    get protocol() {
      return ws.protocol;
    },
    send: (m) => ws.send(JSON.stringify(m)),
    sendRaw: (s) => ws.send(s),
    next: async (pred, ms = 5_000, from = 0) => {
      const until = Date.now() + ms;
      for (;;) {
        const hit = messages.slice(from).find(pred);
        if (hit) return hit;
        if (Date.now() > until) {
          const seen = messages.map((m) => (m.op === "event" ? `event#${String(m.cursor)}` : m.op === "error" ? `error:${String(m.code)}` : m.op)).join(" ");
          throw new Error(`no matching realtime message within ${ms} ms; got [${seen}] (${lastClose})`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    events: () => messages.filter((m) => m.op === "event"),
    closed,
    close: () => ws.close(1000, "done"),
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      ws.onerror = null;
      if (opts.ping !== false) {
        pinger = setInterval(() => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ op: "ping" }));
        }, 50);
      }
      resolve(client);
    };
    ws.onerror = () => reject(new Error("realtime connection refused"));
  });
}

/** A raw upgrade request: 101 when the handshake is accepted, otherwise the HTTP status the server answered. */
export function upgradeStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/v1/realtime",
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), ...headers },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", (e) => reject(new Error(`upgrade with ${Object.keys(headers).join(",") || "no credentials"}: ${e.message}`)));
    req.end();
  });
}
