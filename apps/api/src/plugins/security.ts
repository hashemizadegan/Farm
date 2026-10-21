import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Redis } from "ioredis";
import type { ApiEnv } from "@metafarm/config";
import { HttpError, sendError } from "../lib/http";

/**
 * Security middleware:
 *  - strict security headers (API only serves JSON; CSP denies everything),
 *  - CORS limited to configured origins, credentials off (bearer tokens only),
 *  - per-IP rate limiting with a stricter bucket for auth-sensitive routes, counted per process or,
 *    with RATE_LIMIT_STORE=redis, in Redis shared by all replicas (fail open if Redis is unreachable),
 *  - uniform error responses that never leak stack traces.
 * Body-size limits are set on the Fastify instance (bodyLimit).
 */
export const securityPlugin = fp(async (app: FastifyInstance, opts: { env: ApiEnv; rateLimitRedis?: Redis }) => {
  const shared = opts.env.RATE_LIMIT_STORE === "redis";
  if (shared && !opts.rateLimitRedis) throw new Error("RATE_LIMIT_STORE=redis needs a Redis client for rate limits");
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "no-referrer" },
    hsts: opts.env.APP_ENV === "production" || opts.env.APP_ENV === "staging" ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Non-browser clients (curl, server-to-server) send no Origin header.
      if (!origin) return cb(null, true);
      cb(null, opts.env.CORS_ORIGINS.includes(origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["authorization", "content-type", "x-request-id", "idempotency-key"],
    exposedHeaders: ["x-request-id", "retry-after", "content-disposition", "x-row-count", "idempotent-replayed"],
    credentials: false,
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: opts.env.RATE_LIMIT_MAX,
    timeWindow: opts.env.RATE_LIMIT_WINDOW,
    ...(shared
      ? {
          redis: opts.rateLimitRedis,
          nameSpace: `${opts.env.QUEUE_PREFIX}:rate-limit:`,
          // A Redis outage must not take the API down: requests are served unlimited and the error is logged.
          skipOnError: true,
        }
      : {}),
    keyGenerator: (req) => req.ip,
    allowList: (req) => req.url === "/healthz" || req.url === "/readyz",
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: "rate_limited",
      message: `too many requests; retry after ${Math.ceil(ctx.ttl / 1000)}s`,
    }),
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("cache-control", "no-store");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return sendError(reply, req, err);
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.status(429).send(err);
    if (status === 413 || (err as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return sendError(reply, req, new HttpError(413, "payload_too_large", "request body too large"));
    }
    if ((err as { validation?: unknown }).validation || status === 400 || (err as { code?: string }).code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return sendError(reply, req, new HttpError(status && status < 500 ? status : 400, "invalid_request", "malformed request"));
    }
    if (status === 415) return sendError(reply, req, new HttpError(415, "unsupported_media_type", "unsupported content type"));
    req.log.error({ err }, "unhandled error");
    return sendError(reply, req, new HttpError(500, "internal_error", "an unexpected error occurred"));
  });

  app.setNotFoundHandler((req, reply) => sendError(reply, req, new HttpError(404, "not_found", "route not found")));
});
