/** The middleware with the preview gate wired in: off by default (CSP as before), on = every path gated. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { config, middleware } from "./middleware";

const SECRET = "s3cret-preview-password-0123456789";
const at = (path: string, authorization?: string) => new NextRequest(`http://localhost:3000${path}`, { headers: authorization ? { authorization } : {} });

afterEach(() => vi.unstubAllEnvs());

describe("middleware", () => {
  it("covers every path, static assets included", () => {
    expect(config.matcher).toEqual([{ source: "/:path*" }]);
  });

  it("gate off: pages get the CSP, static assets pass untouched (unchanged behaviour)", async () => {
    vi.stubEnv("PREVIEW_ACCESS_GATE", "");
    const page = await middleware(at("/yield"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    const asset = await middleware(at("/_next/static/chunks/main.js"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-security-policy")).toBeNull();
  });

  it("gate on: refuses pages and assets without credentials, admits the right ones", async () => {
    vi.stubEnv("PREVIEW_ACCESS_GATE", "true");
    vi.stubEnv("PREVIEW_ACCESS_PASSWORD", SECRET);
    for (const path of ["/", "/yield", "/_next/static/chunks/main.js"]) expect((await middleware(at(path))).status, path).toBe(401);
    const ok = await middleware(at("/yield", `Basic ${btoa(`preview:${SECRET}`)}`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect((await middleware(at("/healthz"))).status).toBe(200);
  });

  it("gate on without a password: 503 everywhere except the health check", async () => {
    vi.stubEnv("PREVIEW_ACCESS_GATE", "true");
    vi.stubEnv("PREVIEW_ACCESS_PASSWORD", "");
    expect((await middleware(at("/yield"))).status).toBe(503);
    expect((await middleware(at("/healthz"))).status).toBe(200);
  });
});
