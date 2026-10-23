/**
 * Test clients for the realtime channel against a listening app. `connectRealtime` is a minimal RFC 6455 client over a
 * raw HTTP upgrade (no library between the test and the frames), browser-like: the token travels as the
 * `bearer.<token>` subprotocol. `upgradeStatus` checks handshakes (header authentication, status codes).
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";

type Msg = Record<string, unknown> & { op: string };

/** One masked client frame (RFC 6455 §5.2). */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 0xff]);
  if (len > 0xffff) throw new Error("test frames stay under 64 KiB");
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([head, mask, body]);
}

/** Parses unmasked server frames from a growing buffer; returns the frames read and the unread rest. */
function readFrames(buf: Buffer): { frames: { opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const opcode = buf[off]! & 0x0f;
    let len = buf[off + 1]! & 0x7f;
    let head = 2;
    if (len === 126) {
      if (buf.length - off < 4) break;
      len = buf.readUInt16BE(off + 2);
      head = 4;
    } else if (len === 127) {
      if (buf.length - off < 10) break;
      len = Number(buf.readBigUInt64BE(off + 2));
      head = 10;
    }
    if (buf.length - off < head + len) break;
    frames.push({ opcode, payload: buf.subarray(off + head, off + head + len) });
    off += head + len;
  }
  return { frames, rest: buf.subarray(off) };
}

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
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/v1/realtime",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Protocol": `metafarm-realtime.1, bearer.${token}`,
      },
    });
    req.on("response", (res) => {
      res.resume();
      reject(new Error(`realtime connection refused (HTTP ${res.statusCode})`));
    });
    req.on("error", reject);
    req.on("upgrade", (res, socket: Duplex, head: Buffer) => {
      const messages: Msg[] = [];
      let pending = head;
      let lastClose = "open";
      let closedNow = false;
      let resolveClosed: (v: { code: number; reason: string }) => void = () => undefined;
      const closed = new Promise<{ code: number; reason: string }>((r) => (resolveClosed = r));
      const finish = (code: number, reason: string) => {
        if (closedNow) return;
        closedNow = true;
        clearInterval(pinger);
        lastClose = `closed ${code} ${reason}`;
        resolveClosed({ code, reason });
      };
      const write = (opcode: number, payload: Buffer) => {
        if (!closedNow && !socket.destroyed) socket.write(clientFrame(opcode, payload));
      };
      const onData = (chunk: Buffer) => {
        const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
        pending = rest;
        for (const f of frames) {
          if (f.opcode === 1) messages.push(JSON.parse(f.payload.toString("utf8")) as Msg);
          else if (f.opcode === 9) write(10, f.payload);
          else if (f.opcode === 8) {
            const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
            write(8, f.payload.subarray(0, 2));
            finish(code, f.payload.subarray(2).toString("utf8"));
            socket.end();
          }
        }
      };
      socket.on("data", onData);
      socket.on("close", () => finish(1006, ""));
      socket.on("error", () => finish(1006, ""));
      const pinger = setInterval(() => {
        if (opts.ping !== false) write(1, Buffer.from(JSON.stringify({ op: "ping" })));
      }, 50);
      if (pending.length) onData(Buffer.alloc(0));
      const protocol = String(res.headers["sec-websocket-protocol"] ?? "");
      resolve({
        messages,
        protocol,
        send: (m) => write(1, Buffer.from(JSON.stringify(m))),
        sendRaw: (s) => write(1, Buffer.from(s)),
        next: async (pred, ms = 5_000, from = 0) => {
          const until = Date.now() + ms;
          for (;;) {
            const hit = messages.slice(from).find(pred);
            if (hit) return hit;
            if (Date.now() > until) {
              const seen = messages.map((m) => (m.op === "event" ? `event#${String(m.cursor)}` : m.op === "error" ? `error:${String(m.code)}` : m.op)).filter((x) => x !== "pong" && x !== "heartbeat");
              throw new Error(`no matching realtime message within ${ms} ms; got [${seen.join(" ")}] (${lastClose})`);
            }
            await new Promise((r) => setTimeout(r, 10));
          }
        },
        events: () => messages.filter((m) => m.op === "event"),
        closed,
        close: () => {
          const payload = Buffer.alloc(2);
          payload.writeUInt16BE(1000);
          write(8, payload);
          setTimeout(() => socket.destroy(), 200).unref();
        },
      });
    });
    req.end();
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
