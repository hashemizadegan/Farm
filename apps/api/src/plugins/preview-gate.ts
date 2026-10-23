import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { HttpError } from "../lib/http";
import { adoptProtocolBearer, isUpgrade, refuseUpgrade } from "../routes/realtime";

/** Paths the platform's health checks call without credentials. Exact matches only. */
const OPEN_PATHS: ReadonlySet<string> = new Set(["/healthz", "/readyz"]);

/** Whether a request may pass the preview gate without authentication. */
export function isOpenPath(req: Pick<FastifyRequest, "method" | "url">): boolean {
  if (req.method === "OPTIONS") return true; // CORS preflights carry no credentials; @fastify/cors answers them.
  const path = req.url.split("?", 1)[0] ?? "";
  return OPEN_PATHS.has(path);
}

const INTEGRATION_EVENTS = /^\/v1\/integrations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/events$/i;

/**
 * Device and integration ingestion carry their own credential, which their route verifies and refuses (fail closed):
 * a sensor token (`Authorization: Sensor mfs_…`) on POST /v1/ingest/readings, and a signed event
 * (`x-webhook-signature`) on POST /v1/integrations/{id}/events. Such a request is passed to its route instead of
 * being asked for a person's bearer token, which a device or a provider never has. Anything else is gated.
 */
export function isSelfAuthenticatedIngest(req: Pick<FastifyRequest, "method" | "url" | "headers">): boolean {
  if (req.method !== "POST") return false;
  const path = req.url.split("?", 1)[0] ?? "";
  if (path === "/v1/ingest/readings") return /^Sensor mfs_/.test(String(req.headers.authorization ?? ""));
  if (INTEGRATION_EVENTS.test(path)) return typeof req.headers["x-webhook-signature"] === "string";
  return false;
}

/**
 * Private-preview access gate (PREVIEW_ACCESS_GATE). When on, every request except health checks, CORS preflights
 * and self-authenticated ingestion must carry a bearer token the configured auth provider verifies; anything else
 * gets the standard 401 before any route runs. The realtime channel's browser token (the `bearer.<token>`
 * subprotocol) counts as a bearer token. It fails closed: an error while verifying is a refusal. Off (the default)
 * it registers nothing, so deployed environments are unaffected unless they opt in.
 */
export const previewGatePlugin = fp(async (app: FastifyInstance, opts: { enabled: boolean }) => {
  if (!opts.enabled) return;
  app.addHook("onRequest", async (req, reply) => {
    if (isOpenPath(req) || isSelfAuthenticatedIngest(req)) return;
    const realtime = (req.url.split("?", 1)[0] ?? "") === "/v1/realtime";
    if (realtime) adoptProtocolBearer(req);
    try {
      await app.authenticate(req);
    } catch (err) {
      // A refused WebSocket handshake is answered on the raw socket, so the client reliably reads the 401.
      if (realtime && err instanceof HttpError && isUpgrade(req)) return refuseUpgrade(req, reply, err);
      throw err;
    }
  });
});
