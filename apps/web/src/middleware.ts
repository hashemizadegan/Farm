import { NextResponse, type NextRequest } from "next/server";
import { decidePreviewGate, previewGateResponse } from "./lib/preview-gate";

/** Paths that never got the CSP (static build output); the matcher now reaches them only for the preview gate. */
const STATIC_PATH = /^\/(?:_next\/static|_next\/image|favicon\.ico)(?:\/|$)/;

/**
 * Per-request Content Security Policy with a nonce. Next.js applies the nonce
 * to its own inline scripts when it finds it in the request's CSP header.
 *
 * connect-src lists the API, the OIDC provider, the map hosts
 * (NEXT_PUBLIC_MAP_CONNECT_SRC) and the object-storage origin that presigned
 * uploads PUT to (NEXT_PUBLIC_UPLOAD_CONNECT_SRC). Both are space-separated.
 */
export async function middleware(req: NextRequest) {
  // Private-preview gate (off unless PREVIEW_ACCESS_GATE is set; see lib/preview-gate.ts). Runs first, on every
  // path including static assets, so nothing is served around it.
  const gate = await decidePreviewGate(
    {
      PREVIEW_ACCESS_GATE: process.env.PREVIEW_ACCESS_GATE,
      PREVIEW_ACCESS_PASSWORD: process.env.PREVIEW_ACCESS_PASSWORD,
      APP_ENV: process.env.APP_ENV,
      RAILWAY_PROJECT_ID: process.env.RAILWAY_PROJECT_ID,
    },
    { method: req.method, pathname: req.nextUrl.pathname, authorization: req.headers.get("authorization") },
  );
  if (gate.kind === "deny") return previewGateResponse(gate.status);
  // Unchanged behaviour for static output: no CSP header, as before the matcher was widened.
  if (STATIC_PATH.test(req.nextUrl.pathname)) return NextResponse.next();

  // Edge runtime: no Buffer; btoa is available.
  const nonce = btoa(crypto.randomUUID());
  const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const mapHosts = (process.env.NEXT_PUBLIC_MAP_CONNECT_SRC ?? "").split(/\s+/).filter(Boolean);
  const uploadHosts = (process.env.NEXT_PUBLIC_UPLOAD_CONNECT_SRC ?? "").split(/\s+/).filter(Boolean);
  // The browser fetches OIDC discovery, JWKS and the token endpoint from the provider.
  const oidc = process.env.NEXT_PUBLIC_OIDC_AUTHORITY ? new URL(process.env.NEXT_PUBLIC_OIDC_AUTHORITY).origin : "";
  const dev = process.env.NODE_ENV !== "production";

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // MapLibre and Next inject style attributes at runtime.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: ${mapHosts.join(" ")}`.trim(),
    `font-src 'self' data:`,
    `connect-src 'self' ${api} ${oidc} ${mapHosts.join(" ")} ${uploadHosts.join(" ")} ${dev ? "ws:" : ""}`.replace(/\s+/g, " ").trim(),
    // MapLibre runs its tile parsing in blob: workers.
    `worker-src 'self' blob:`,
    `child-src blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    dev ? "" : "upgrade-insecure-requests",
  ]
    .filter(Boolean)
    .join("; ");

  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("content-security-policy", csp);
  return res;
}

export const config = {
  // Every path, so the preview gate also covers static assets; STATIC_PATH keeps their old (CSP-free) handling.
  matcher: [{ source: "/:path*" }],
};
