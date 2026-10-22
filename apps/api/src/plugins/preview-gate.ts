import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

/** Paths the platform's health checks call without credentials. Exact matches only. */
const OPEN_PATHS: ReadonlySet<string> = new Set(["/healthz", "/readyz"]);

/** Whether a request may pass the preview gate without authentication. */
export function isOpenPath(req: Pick<FastifyRequest, "method" | "url">): boolean {
  if (req.method === "OPTIONS") return true; // CORS preflights carry no credentials; @fastify/cors answers them.
  const path = req.url.split("?", 1)[0] ?? "";
  return OPEN_PATHS.has(path);
}

/**
 * Private-preview access gate (PREVIEW_ACCESS_GATE). When on, every request except health checks and CORS
 * preflights must carry a bearer token the configured auth provider verifies; anything else gets the standard
 * 401 before any route runs. It fails closed: an error while verifying is a refusal. Off (the default) it
 * registers nothing, so deployed environments are unaffected unless they opt in.
 */
export const previewGatePlugin = fp(async (app: FastifyInstance, opts: { enabled: boolean }) => {
  if (!opts.enabled) return;
  app.addHook("onRequest", async (req) => {
    if (isOpenPath(req)) return;
    await app.authenticate(req);
  });
});
