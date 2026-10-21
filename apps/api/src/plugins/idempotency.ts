import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { completeIdempotency, findMembershipRole, releaseIdempotency, reserveIdempotency, withTenant } from "@metafarm/db";
import { HttpError, idempotencyKey, keyReused } from "../lib/http";

declare module "fastify" {
  interface FastifyContextConfig {
    /** `handler`: the route implements Idempotency-Key itself, so the generic layer stays out of it. */
    idempotency?: "handler";
  }
  interface FastifyRequest {
    idempotency?: { tenantId: string; userId: string; key: string };
  }
}

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TENANT_ROUTE = /^\/v1\/tenants\/:tenantId(\/|$)/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Larger responses are not stored; their key then stays reserved and a resend is refused, never re-run. */
const MAX_STORED_BYTES = 1024 * 1024;

/** The request a key is bound to: method, concrete URL (with query) and body. */
export function idempotencyRequestHash(req: Pick<FastifyRequest, "method" | "url" | "body">): string {
  return createHash("sha256")
    .update(JSON.stringify([req.method, req.url, req.body ?? null]))
    .digest("hex");
}

/**
 * Idempotency-Key for every tenant-scoped write by a signed-in user (API hardening).
 *
 * With the header, the first request reserves the key (per tenant and user) before the handler runs.
 * A successful (2xx) response is stored; a failed one releases the key so the client can retry it.
 * A resend with the same key and request gets the stored response with `Idempotent-Replayed: true`;
 * a different request under the key is refused (409 `idempotency_key_reused`), and so is a resend
 * while the first request has not finished (409 `idempotency_request_in_progress`). Keys are kept
 * for IDEMPOTENCY_RETENTION_HOURS. Without the header, nothing changes.
 *
 * It never runs a write twice for one key: if the outcome could not be stored (a crash after the
 * write committed, a response that cannot be stored), the key stays reserved and resends are refused
 * rather than repeated.
 */
export const idempotencyPlugin = fp(async (app: FastifyInstance) => {
  app.addHook("preHandler", async (req, reply) => {
    if (!WRITES.has(req.method)) return;
    const pattern = req.routeOptions.url;
    if (!pattern || !TENANT_ROUTE.test(pattern)) return;
    if (req.routeOptions.config.idempotency === "handler") return;
    const key = idempotencyKey(req);
    if (!key) return;

    await app.authenticate(req);
    const tenantId = (req.params as { tenantId?: string }).tenantId;
    // Unknown tenant or no membership: the handler answers (404) and audits it; nothing is reserved.
    if (!tenantId || !UUID.test(tenantId)) return;
    const userId = req.user!.id;
    if (!(await findMembershipRole(app.deps.pool, tenantId, userId))) return;

    const scope = { tenantId, userId, key };
    const requestHash = idempotencyRequestHash(req);
    const r = await withTenant(app.deps.pool, tenantId, (tx) => reserveIdempotency(tx, { ...scope, method: req.method, route: pattern, requestHash }));
    if (r.reserved) {
      req.idempotency = scope;
      return;
    }
    const seen = r.existing;
    if (seen.method !== req.method || seen.route !== pattern || seen.requestHash !== requestHash) throw keyReused();
    if (seen.state === "pending") {
      throw new HttpError(
        409,
        "idempotency_request_in_progress",
        "a request with this Idempotency-Key has not finished, or its outcome was not recorded; check the result before writing again",
      );
    }
    reply.header("idempotent-replayed", "true");
    if (seen.contentType) reply.header("content-type", seen.contentType);
    return reply.code(seen.statusCode!).send(seen.body ?? "");
  });

  app.addHook("onSend", async (req, reply, payload) => {
    const scope = req.idempotency;
    if (!scope) return payload;
    req.idempotency = undefined;
    try {
      const ok = reply.statusCode >= 200 && reply.statusCode < 300;
      if (!ok) {
        // The write did not happen (handlers roll back on error), so the key may be used again.
        await withTenant(app.deps.pool, scope.tenantId, (tx) => releaseIdempotency(tx, scope));
        return payload;
      }
      const body = typeof payload === "string" ? payload : Buffer.isBuffer(payload) ? payload.toString("utf8") : payload == null ? "" : null;
      if (body === null || Buffer.byteLength(body) > MAX_STORED_BYTES) {
        req.log.warn({ route: req.routeOptions.url }, "idempotent response not stored; resends with this key will be refused");
        return payload;
      }
      const contentType = reply.getHeader("content-type");
      await withTenant(app.deps.pool, scope.tenantId, (tx) =>
        completeIdempotency(tx, scope, { statusCode: reply.statusCode, contentType: typeof contentType === "string" ? contentType : null, body }),
      );
    } catch (err) {
      // The response stands (the write is done); the key stays reserved, so a resend is refused, not repeated.
      req.log.warn({ err }, "could not record the idempotent outcome");
    }
    return payload;
  });
});
