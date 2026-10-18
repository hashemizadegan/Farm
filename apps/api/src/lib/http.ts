import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeAny, z } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (what = "resource") => new HttpError(404, "not_found", `${what} not found`);
export const forbidden = () => new HttpError(403, "forbidden", "you do not have permission for this action");
export const unauthorized = () => new HttpError(401, "unauthorized", "authentication required");

export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HttpError(
      400,
      "invalid_request",
      "request validation failed",
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

/**
 * Salted hash of the client IP for audit records: lets us correlate abuse
 * without storing raw addresses. The salt rotates with deployments by design.
 */
const IP_SALT = process.env.AUDIT_IP_SALT ?? "metafarm";
export function hashIp(ip: string | undefined): string | undefined {
  return ip ? createHash("sha256").update(`${IP_SALT}:${ip}`).digest("hex").slice(0, 32) : undefined;
}

export function sendError(reply: FastifyReply, req: FastifyRequest, err: HttpError) {
  return reply.status(err.statusCode).send({
    error: err.code,
    message: err.message,
    requestId: req.id,
    ...(err.details ? { details: err.details } : {}),
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The client's `Idempotency-Key` (a UUID), sent with writes an offline phone may resend.
 * A resend of a write that already succeeded returns the original result instead of recording twice.
 */
export function idempotencyKey(req: FastifyRequest): string | undefined {
  const v = req.headers["idempotency-key"];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !UUID.test(v)) throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be a UUID");
  return v.toLowerCase();
}

export const keyReused = () => new HttpError(409, "idempotency_key_reused", "this Idempotency-Key was already used for a different request");
