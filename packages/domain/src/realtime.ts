/**
 * Realtime connection contract `metafarm-realtime.1` (WebSocket at GET /v1/realtime, apps/api/src/routes/realtime.ts).
 *
 * Handshake: the client authenticates during the upgrade, with `Authorization: Bearer <token>` or, where a client
 * cannot set headers (browsers), the subprotocol pair `metafarm-realtime.1, bearer.<token>`. The server answers the
 * subprotocol `metafarm-realtime.1` only; an unauthenticated upgrade is refused with HTTP 401 before any socket opens.
 *
 * After the upgrade the client sends exactly one `subscribe` naming one workspace (tenant), optionally one farm, the
 * event types it wants and a replay cursor (`after`, the last `cursor` it processed, or null for "from now"). The
 * server checks membership, the permission each type needs and that the farm belongs to the workspace (database),
 * then answers `subscribed` and delivers `event` messages in cursor order: first the replay after the cursor, then
 * new events. Cursors are per workspace and strictly increasing; a client persists the last one it processed and
 * resumes with it, so a reconnect neither loses nor repeats events (a repeat after a crash is harmless: `event.id`
 * is unique). A second `subscribe` on a connection that already subscribed with the same request is answered again
 * with `subscribed` (idempotent); a different one is refused (one subscription per connection).
 *
 * Heartbeat: the server sends `heartbeat` every `heartbeatIntervalMs`; the client sends `ping` (answered with `pong`)
 * at least every `heartbeatTimeoutMs`, or the server closes with 4408. Backpressure: a connection whose unsent
 * buffer exceeds `maxBufferedBytes` is closed with 1013 (try again later) and resumes from its cursor.
 *
 * Errors: `{ op: "error", code, message }`, followed by a close with the matching code when `close` is true.
 * Events are notifications only. Nothing here carries or accepts a financial or ownership mutation: clients send
 * `subscribe` and `ping`, nothing else.
 */
import { z } from "zod";
import { EVENT_TYPES, type EventEnvelope, type EventType } from "./events";

export const REALTIME_PROTOCOL = "metafarm-realtime.1";
export const REALTIME_BEARER_PREFIX = "bearer.";

export const REALTIME_LIMITS = {
  /** Largest client message accepted (bytes); larger frames close the connection. */
  maxClientMessageBytes: 4_096,
  maxTypes: 16,
  /** Events read from the outbox per poll (replay pages through in batches of this size). */
  batchSize: 200,
  /** How often the server polls the outbox for a live subscription. */
  pollIntervalMs: 1_000,
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 45_000,
  /** Unsent bytes allowed on a socket before the server gives up on a slow reader (1013). */
  maxBufferedBytes: 1_048_576,
  /** Time a client has to subscribe after the upgrade. */
  subscribeTimeoutMs: 10_000,
} as const;

export const REALTIME_CLOSE = {
  normal: 1000,
  goingAway: 1001,
  tryAgainLater: 1013,
  malformed: 4400,
  forbidden: 4403,
  notFound: 4404,
  heartbeatTimeout: 4408,
  conflict: 4409,
} as const;

/** Cursor: the outbox sequence as a decimal string (a bigint; strings keep every client exact). */
export const realtimeCursor = z.string().regex(/^(0|[1-9]\d{0,18})$/, "a cursor is a non-negative decimal integer");

const uuid = z.string().uuid();
const eventType = z.string().refine((t) => Object.prototype.hasOwnProperty.call(EVENT_TYPES, t), "unknown event type");

export const realtimeSubscribeSchema = z
  .object({
    op: z.literal("subscribe"),
    tenantId: uuid,
    farmId: uuid.nullable(),
    types: z.array(eventType).min(1).max(REALTIME_LIMITS.maxTypes),
    after: realtimeCursor.nullable(),
  })
  .strict();
export type RealtimeSubscribe = Omit<z.infer<typeof realtimeSubscribeSchema>, "types"> & { types: EventType[] };

export const realtimeClientMessageSchema = z.discriminatedUnion("op", [realtimeSubscribeSchema, z.object({ op: z.literal("ping") }).strict()]);
export type RealtimeClientMessage = RealtimeSubscribe | { op: "ping" };

export type RealtimeErrorCode =
  | "malformed"
  | "unknown_type"
  | "not_found"
  | "forbidden"
  | "farm_scope_required"
  | "already_subscribed"
  | "not_subscribed"
  | "subscribe_timeout"
  | "heartbeat_timeout"
  | "backpressure";

export type RealtimeServerMessage =
  | { op: "subscribed"; tenantId: string; farmId: string | null; types: EventType[]; cursor: string | null }
  | { op: "event"; cursor: string; event: EventEnvelope }
  | { op: "heartbeat"; cursor: string | null }
  | { op: "pong" }
  | { op: "error"; code: RealtimeErrorCode; message: string; close: boolean };

export type ParsedClientMessage = { ok: true; message: RealtimeClientMessage } | { ok: false; code: "malformed" | "unknown_type"; message: string };

/** Parses one client frame. Text JSON only, bounded size, exact keys; never throws. */
export function parseRealtimeClientMessage(raw: string | Uint8Array): ParsedClientMessage {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  if (bytes.byteLength > REALTIME_LIMITS.maxClientMessageBytes) return { ok: false, code: "malformed", message: "message too large" };
  let text: string;
  try {
    text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { ok: false, code: "malformed", message: "message is not UTF-8" };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: "malformed", message: "message is not JSON" };
  }
  const r = realtimeClientMessageSchema.safeParse(json);
  if (!r.success) {
    const unknownType = r.error.issues.some((i) => i.message === "unknown event type");
    return {
      ok: false,
      code: unknownType ? "unknown_type" : "malformed",
      message: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ").slice(0, 300),
    };
  }
  const m = r.data;
  return { ok: true, message: m.op === "subscribe" ? { ...m, types: [...new Set(m.types)] as EventType[] } : m };
}

/** Workspace-scoped types (e.g. yield.cycle.updated) need `farmId: null`; a farm subscription receives farm-scoped types for that farm only. */
export function subscriptionScopeProblem(s: RealtimeSubscribe): string | null {
  if (s.farmId === null) return null;
  const workspaceOnly = s.types.filter((t) => !EVENT_TYPES[t].farmScoped);
  return workspaceOnly.length ? `${workspaceOnly.join(", ")} ${workspaceOnly.length === 1 ? "is" : "are"} workspace-scoped: subscribe with farmId null` : null;
}

/** Same subscription request (types compared as sets): a repeated subscribe after a lost acknowledgement. */
export function sameSubscription(a: RealtimeSubscribe, b: RealtimeSubscribe): boolean {
  const ta = [...a.types].sort();
  const tb = [...b.types].sort();
  return a.tenantId === b.tenantId && a.farmId === b.farmId && ta.length === tb.length && ta.every((t, i) => t === tb[i]);
}

/** The bearer token from a subprotocol list (`bearer.<token>`), when the client could not send a header. */
export function bearerFromProtocols(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const parts = header.split(",").map((p) => p.trim());
  if (!parts.includes(REALTIME_PROTOCOL)) return undefined;
  const t = parts.find((p) => p.startsWith(REALTIME_BEARER_PREFIX))?.slice(REALTIME_BEARER_PREFIX.length);
  return t && /^[A-Za-z0-9._~-]{1,8192}$/.test(t) ? t : undefined;
}
