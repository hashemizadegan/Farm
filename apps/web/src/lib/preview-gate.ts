/**
 * Private-preview access gate for the web app (HTTP Basic, user `preview`).
 *
 * Server-side configuration only, never NEXT_PUBLIC (so nothing reaches the browser bundle):
 *   PREVIEW_ACCESS_GATE      "true" | "1" | "on" turns it on; unset, "false", "0", "off" leaves it off;
 *                            any other value turns it on (a typo must not open the preview).
 *   PREVIEW_ACCESS_PASSWORD  the shared secret, at least 24 characters. Gate on and no usable password:
 *                            every request is refused with 503 (fails closed).
 *
 * Browsers cache Basic credentials per origin and send them on every same-origin request, so page
 * navigations, Next.js data requests and static assets are all covered by one prompt. The secret is compared
 * by SHA-256 digest in constant time and never logged or echoed.
 *
 * Only GET /healthz (the platform health check, which carries no credentials) passes without them.
 */

export const PREVIEW_USER = "preview";
export const PREVIEW_PASSWORD_MIN_LENGTH = 24;
export const PREVIEW_HEALTH_PATH = "/healthz";

export type PreviewGateDecision = { kind: "off" } | { kind: "allow" } | { kind: "deny"; status: 401 | 503 };

export function previewGateEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "false" || v === "0" || v === "off") return false;
  return true;
}

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Constant-time comparison of two strings through their SHA-256 digests (equal length by construction). */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** Parses `Basic base64(user:password)`; undefined when absent or malformed. */
export function parseBasic(header: string | null): { user: string; password: string } | undefined {
  if (!header) return undefined;
  const m = /^Basic\s+([A-Za-z0-9+/=]{1,1024})$/i.exec(header.trim());
  if (!m) return undefined;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return undefined;
  return { user: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

/**
 * A development or test build running on the platform (Railway sets RAILWAY_PROJECT_ID on every deployed service) is
 * a preview and must be private. With the gate off it is refused (503), not served openly. Production and staging
 * web services are unaffected: they do not run with APP_ENV development or test.
 */
export function deployedDevelopment(env: { APP_ENV?: string; RAILWAY_PROJECT_ID?: string }): boolean {
  return Boolean(env.RAILWAY_PROJECT_ID) && (env.APP_ENV === "development" || env.APP_ENV === "test");
}

export async function decidePreviewGate(
  env: { PREVIEW_ACCESS_GATE?: string; PREVIEW_ACCESS_PASSWORD?: string; APP_ENV?: string; RAILWAY_PROJECT_ID?: string },
  req: { method: string; pathname: string; authorization: string | null },
): Promise<PreviewGateDecision> {
  if (!previewGateEnabled(env.PREVIEW_ACCESS_GATE)) {
    if (deployedDevelopment(env) && req.pathname !== PREVIEW_HEALTH_PATH) return { kind: "deny", status: 503 };
    return { kind: "off" };
  }
  if ((req.method === "GET" || req.method === "HEAD") && req.pathname === PREVIEW_HEALTH_PATH) return { kind: "allow" };
  const secret = env.PREVIEW_ACCESS_PASSWORD ?? "";
  if (secret.length < PREVIEW_PASSWORD_MIN_LENGTH) return { kind: "deny", status: 503 };
  const creds = parseBasic(req.authorization);
  if (!creds) return { kind: "deny", status: 401 };
  // Evaluate both checks so the timing does not reveal which one failed.
  const userOk = await sameSecret(creds.user, PREVIEW_USER);
  const passwordOk = await sameSecret(creds.password, secret);
  return userOk && passwordOk ? { kind: "allow" } : { kind: "deny", status: 401 };
}

/** The response for a refused request: no body detail, never cached, Basic challenge on 401. */
export function previewGateResponse(status: 401 | 503): Response {
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
  if (status === 401) headers["www-authenticate"] = 'Basic realm="MetaFarm preview", charset="UTF-8"';
  return new Response(status === 401 ? "Authentication required" : "Preview access is not configured", { status, headers });
}
