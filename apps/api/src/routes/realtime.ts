/**
 * Authenticated realtime channel: WebSocket GET /v1/realtime, protocol `metafarm-realtime.1` (packages/domain
 * realtime.ts), reading the realtime outbox (migration 0030). Registered only when REALTIME_EVENTS_ENABLED is on;
 * otherwise the path does not exist and clients poll as before.
 *
 * - Handshake: the token is checked before the upgrade (HTTP 401 and no socket otherwise).
 * - Subscription: one per connection; membership, the permission of every requested type and the farm's workspace
 *   are checked against the database. Unknown workspaces and farms answer `not_found` (existence is not revealed).
 * - Delivery: the outbox is read per connection in cursor order, inside the subscription's workspace only; each event
 *   is authorized again (authorizeEvent) with the farm's workspace from the database. Membership is re-checked at
 *   every heartbeat, so a removed member loses the stream within one interval.
 * - Liveness and flow control: heartbeat timeout (4408), bounded send buffer (1013), bounded message size (1009 by
 *   the WebSocket layer), subscribe timeout.
 * Clients can only subscribe and ping: nothing received here changes any state.
 */
import { STATUS_CODES } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { findMembershipRole, latestRealtimeCursor, listRealtimeEventsAfter, realtimeRetentionHorizon, withTenant, writeSystemAudit } from "@metafarm/db";
import {
  EVENT_TYPES,
  REALTIME_CLOSE,
  REALTIME_LIMITS,
  authorizeEvent,
  bearerFromProtocols,
  can,
  parseRealtimeClientMessage,
  sameSubscription,
  subscriptionScopeProblem,
  type RealtimeErrorCode,
  type RealtimeServerMessage,
  type RealtimeSubscribe,
  type Role,
} from "@metafarm/domain";
import { HttpError, hashIp } from "../lib/http";

/** Numeric cursor comparison (decimal strings of a bigint): is `cursor` strictly below `other`? */
export const isBehind = (cursor: string, other: string | null): boolean => other !== null && BigInt(cursor) < BigInt(other);
/** The later of two cursors (null = none). A resync never lands below the horizon, even if newer rows are gone too. */
const laterOf = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : isBehind(a, b) ? b : a);

export type RealtimeLimits = { -readonly [K in keyof typeof REALTIME_LIMITS]: number };

/** Copies a subprotocol bearer token into the Authorization header (browsers cannot set headers on a WebSocket). */
export function adoptProtocolBearer(req: FastifyRequest): void {
  if (req.headers.authorization) return;
  const raw = req.headers["sec-websocket-protocol"];
  const token = bearerFromProtocols(Array.isArray(raw) ? raw.join(",") : raw);
  if (token) req.headers.authorization = `Bearer ${token}`;
}

export async function realtimeRoutes(app: FastifyInstance, opts: { limits?: Partial<RealtimeLimits> }) {
  const limits: RealtimeLimits = { ...REALTIME_LIMITS, ...opts.limits };
  app.get(
    "/v1/realtime",
    {
      websocket: true,
      // Connection attempts per client address: a twentieth of the general limit (60 at the default 1200).
      config: { rateLimit: { max: Math.max(10, Math.floor(app.deps.env.RATE_LIMIT_MAX / 20)), timeWindow: "1 minute" } },
      preValidation: async (req, reply) => {
        adoptProtocolBearer(req);
        try {
          // Browsers send Origin: only the web app's own origins (CORS_ORIGINS) may open the channel. Native clients
          // (Unity, servers) send none and authenticate with their token like everyone else.
          const origin = req.headers.origin;
          if (origin !== undefined && !app.deps.env.CORS_ORIGINS.includes(origin)) throw new HttpError(403, "origin_not_allowed", "this origin may not open the realtime channel");
          await app.authenticate(req);
        } catch (err) {
          if (!(err instanceof HttpError) || !req.ws) throw err;
          // A refused upgrade: answer on the raw socket and close it gracefully, so the client reliably reads the
          // status (the WebSocket layer would otherwise destroy the socket right after the error response).
          reply.hijack();
          const body = JSON.stringify({ error: err.code, message: err.message });
          req.raw.socket.end(
            `HTTP/1.1 ${err.statusCode} ${STATUS_CODES[err.statusCode] ?? "Error"}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          );
        }
      },
    },
    (socket, req) => {
      new RealtimeSession(app, socket, req, limits).start();
    },
  );
}

class RealtimeSession {
  private sub: RealtimeSubscribe | null = null;
  private role: Role | null = null;
  private cursor: string | null = null;
  private lastSeen = Date.now();
  private closed = false;
  private polling = false;
  private inbox: Promise<void> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly app: FastifyInstance,
    private readonly socket: WebSocket,
    private readonly req: FastifyRequest,
    private readonly limits: RealtimeLimits,
  ) {}

  start(): void {
    // Listeners are attached synchronously: nothing the client sends right after the upgrade is lost.
    this.socket.on("message", (data, isBinary) => {
      this.lastSeen = Date.now();
      if (isBinary) {
        this.fail("malformed", "binary frames are not accepted", REALTIME_CLOSE.malformed);
        return;
      }
      const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      this.inbox = this.inbox.then(() => this.onMessage(raw)).catch((err) => this.crash(err));
    });
    this.socket.on("close", () => this.stop());
    this.socket.on("error", () => this.stop());
    this.timers.push(
      setTimeout(() => {
        if (!this.sub) this.fail("subscribe_timeout", "no subscription received in time", REALTIME_CLOSE.heartbeatTimeout);
      }, this.limits.subscribeTimeoutMs),
      setInterval(() => void this.heartbeat(), this.limits.heartbeatIntervalMs),
    );
  }

  private stop(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private send(m: RealtimeServerMessage): boolean {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return false;
    if (this.socket.bufferedAmount > this.limits.maxBufferedBytes) {
      this.fail("backpressure", "the client is not reading fast enough; reconnect with your last cursor", REALTIME_CLOSE.tryAgainLater);
      return false;
    }
    this.socket.send(JSON.stringify(m));
    return true;
  }

  private fail(code: RealtimeErrorCode, message: string, closeCode: number): void {
    if (this.closed) return;
    this.send({ op: "error", code, message, close: true });
    this.stop();
    this.socket.close(closeCode, code);
  }

  private crash(err: unknown): void {
    this.app.log.error({ err }, "realtime session failed");
    if (!this.closed) {
      this.send({ op: "error", code: "internal_error", message: "the server could not continue this stream; reconnect with your last cursor", close: true });
      this.stop();
      this.socket.close(1011, "internal_error");
    }
  }

  private async deny(action: string, tenantId: string): Promise<void> {
    await writeSystemAudit(this.app.deps.pool, null, {
      actorType: "user",
      actorUserId: this.req.user!.id,
      action,
      targetType: "tenant",
      targetId: tenantId,
      outcome: "denied",
      requestId: this.req.id,
      ipHash: hashIp(this.req.ip),
    }).catch(() => undefined);
  }

  private async onMessage(raw: Buffer): Promise<void> {
    if (this.closed) return;
    const parsed = parseRealtimeClientMessage(raw);
    if (!parsed.ok) return this.fail(parsed.code, parsed.message, REALTIME_CLOSE.malformed);
    const m = parsed.message;
    if (m.op === "ping") {
      this.send({ op: "pong" });
      return;
    }
    if (this.sub) {
      // A repeated request (lost acknowledgement) is answered again; a different one is refused.
      if (sameSubscription(this.sub, m)) this.send({ op: "subscribed", tenantId: this.sub.tenantId, farmId: this.sub.farmId, types: this.sub.types, cursor: this.cursor });
      else this.fail("already_subscribed", "one subscription per connection; open another connection", REALTIME_CLOSE.conflict);
      return;
    }
    const scope = subscriptionScopeProblem(m);
    if (scope) return this.fail("farm_scope_required", scope, REALTIME_CLOSE.malformed);

    const { pool } = this.app.deps;
    const role = await findMembershipRole(pool, m.tenantId, this.req.user!.id);
    if (!role) {
      await this.deny("tenant.access_denied", m.tenantId);
      return this.fail("not_found", "workspace not found", REALTIME_CLOSE.notFound);
    }
    const missing = m.types.filter((t) => !can(role, EVENT_TYPES[t].permission));
    if (missing.length) {
      await this.deny("realtime.subscribe_denied", m.tenantId);
      return this.fail("forbidden", `not allowed to receive ${missing.join(", ")}`, REALTIME_CLOSE.forbidden);
    }
    const start = await withTenant(pool, m.tenantId, async (tx) => {
      if (m.farmId !== null) {
        const farm = await tx.query(`SELECT 1 FROM farms WHERE tenant_id = $1 AND id = $2`, [m.tenantId, m.farmId]);
        if (farm.rowCount === 0) return { farm: false as const };
      }
      // A replay cursor below the retention horizon may have missed deleted events: resynchronize instead.
      const horizon = await realtimeRetentionHorizon(tx);
      if (m.after !== null && isBehind(m.after, horizon)) return { farm: true as const, cursor: laterOf(await latestRealtimeCursor(tx), horizon), resync: true };
      return { farm: true as const, cursor: m.after ?? (await latestRealtimeCursor(tx)), resync: false };
    });
    if (!start.farm) return this.fail("not_found", "farm not found", REALTIME_CLOSE.notFound);
    if (this.closed) return;
    this.sub = m;
    this.role = role;
    this.cursor = start.cursor;
    if (start.resync) this.send({ op: "resync", reason: "cursor_expired", cursor: this.cursor });
    this.send({ op: "subscribed", tenantId: m.tenantId, farmId: m.farmId, types: m.types, cursor: this.cursor });
    this.timers.push(setInterval(() => void this.poll(), this.limits.pollIntervalMs));
    void this.poll();
  }

  /** Reads the outbox after the cursor and delivers what the viewer may see, in order; pages through a backlog. */
  private async poll(): Promise<void> {
    if (this.closed || this.polling || !this.sub || !this.role) return;
    this.polling = true;
    try {
      const sub = this.sub;
      const viewer = { roles: { [sub.tenantId]: this.role } };
      for (;;) {
        const batch = await withTenant(this.app.deps.pool, sub.tenantId, async (tx) => {
          // Read first: everything committed up to `latest` is visible to the queries below (appends commit in
          // cursor order per workspace), so an empty page may safely move the cursor up to it.
          const latest = await latestRealtimeCursor(tx);
          const horizon = await realtimeRetentionHorizon(tx);
          if (this.cursor !== null && isBehind(this.cursor, horizon)) return { kind: "resync" as const, cursor: laterOf(latest, horizon) };
          const rows = await listRealtimeEventsAfter(tx, { after: this.cursor, types: sub.types, farmId: sub.farmId, limit: this.limits.batchSize });
          const farmIds = [...new Set(rows.map((r) => r.event.scope.farmId).filter((f): f is string => f !== null))];
          const farms = farmIds.length
            ? new Set((await tx.query<{ id: string }>(`SELECT id FROM farms WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [sub.tenantId, farmIds])).rows.map((r) => r.id))
            : new Set<string>();
          return { kind: "page" as const, rows, farms, latest };
        });
        if (this.closed) return;
        if (batch.kind === "resync") {
          this.cursor = batch.cursor;
          if (!this.send({ op: "resync", reason: "cursor_expired", cursor: this.cursor })) return;
          continue;
        }
        if (batch.rows.length === 0) {
          // Nothing matching after the cursor: skip ahead, so a quiet subscription never falls behind retention.
          if (batch.latest !== null && (this.cursor === null || isBehind(this.cursor, batch.latest))) this.cursor = batch.latest;
          return;
        }
        for (const { seq, event } of batch.rows) {
          // Defence in depth: the query is already bound to the workspace.
          const inScope = event.scope.tenantId === sub.tenantId && (sub.farmId === null || event.scope.farmId === sub.farmId);
          const farmOk = event.scope.farmId === null || batch.farms.has(event.scope.farmId);
          if (inScope && authorizeEvent(event, viewer, farmOk).allow && !this.send({ op: "event", cursor: seq, event })) return;
          this.cursor = seq;
        }
        if (batch.rows.length < this.limits.batchSize) return;
      }
    } catch (err) {
      this.crash(err);
    } finally {
      this.polling = false;
    }
  }

  /** Liveness both ways, and a membership re-check: a removed member or a lowered role ends the stream. */
  private async heartbeat(): Promise<void> {
    if (this.closed) return;
    if (Date.now() - this.lastSeen > this.limits.heartbeatTimeoutMs) {
      this.fail("heartbeat_timeout", "no message from the client within the heartbeat timeout", REALTIME_CLOSE.heartbeatTimeout);
      return;
    }
    if (this.sub) {
      try {
        const role = await findMembershipRole(this.app.deps.pool, this.sub.tenantId, this.req.user!.id);
        if (!role || this.sub.types.some((t) => !can(role, EVENT_TYPES[t].permission))) {
          this.fail("forbidden", "membership or permission changed", REALTIME_CLOSE.forbidden);
          return;
        }
        this.role = role;
      } catch (err) {
        this.crash(err);
        return;
      }
    }
    this.send({ op: "heartbeat", cursor: this.cursor });
  }
}
