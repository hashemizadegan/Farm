import { describe, expect, it } from "vitest";
import { decidePreviewGate, parseBasic, PREVIEW_PASSWORD_MIN_LENGTH, previewGateEnabled, previewGateResponse } from "./preview-gate";

const SECRET = "s3cret-preview-password-0123456789";
const ON = { PREVIEW_ACCESS_GATE: "true", PREVIEW_ACCESS_PASSWORD: SECRET };
const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;
const req = (pathname: string, authorization: string | null = null, method = "GET") => ({ method, pathname, authorization });

describe("preview gate switch", () => {
  it("is off only when unset or explicitly off; anything else turns it on", () => {
    for (const v of [undefined, "", "false", "0", "off", " FALSE "]) expect(previewGateEnabled(v), String(v)).toBe(false);
    for (const v of ["true", "1", "on", "TRUE", "yes", "enabled", "ture"]) expect(previewGateEnabled(v), v).toBe(true);
  });

  it("off: decides nothing, whatever the request", async () => {
    expect(await decidePreviewGate({}, req("/yield"))).toEqual({ kind: "off" });
    expect(await decidePreviewGate({ PREVIEW_ACCESS_GATE: "false", PREVIEW_ACCESS_PASSWORD: SECRET }, req("/"))).toEqual({ kind: "off" });
  });
});

describe("preview gate on", () => {
  it("fails closed (503) when the password is missing or too short", async () => {
    expect(await decidePreviewGate({ PREVIEW_ACCESS_GATE: "true" }, req("/yield", basic("preview", "")))).toEqual({ kind: "deny", status: 503 });
    const short = "x".repeat(PREVIEW_PASSWORD_MIN_LENGTH - 1);
    expect(await decidePreviewGate({ PREVIEW_ACCESS_GATE: "true", PREVIEW_ACCESS_PASSWORD: short }, req("/", basic("preview", short)))).toEqual({ kind: "deny", status: 503 });
  });

  it("refuses requests without valid credentials on every path, assets included", async () => {
    for (const path of ["/", "/yield", "/yield/abc", "/sign-in", "/_next/static/chunks/main.js", "/_next/image", "/favicon.ico", "/manifest.webmanifest", "/offline", "/healthz/x"]) {
      expect(await decidePreviewGate(ON, req(path)), path).toEqual({ kind: "deny", status: 401 });
      expect(await decidePreviewGate(ON, req(path, basic("preview", "wrong-password-wrong-password"))), path).toEqual({ kind: "deny", status: 401 });
    }
  });

  it("refuses the wrong user, other schemes and malformed headers", async () => {
    for (const authorization of [basic("admin", SECRET), basic("preview", `${SECRET}x`), basic("preview", SECRET.slice(1)), `Bearer ${SECRET}`, "Basic !!!", "Basic", basic("", SECRET)]) {
      expect(await decidePreviewGate(ON, req("/yield", authorization)), authorization).toEqual({ kind: "deny", status: 401 });
    }
  });

  it("allows the right credentials", async () => {
    expect(await decidePreviewGate(ON, req("/yield", basic("preview", SECRET)))).toEqual({ kind: "allow" });
    expect(await decidePreviewGate(ON, req("/_next/static/chunks/main.js", basic("preview", SECRET)))).toEqual({ kind: "allow" });
    // A password containing ':' survives (only the first colon separates the user).
    const colon = `${SECRET}:with:colons`;
    expect(await decidePreviewGate({ ...ON, PREVIEW_ACCESS_PASSWORD: colon }, req("/", basic("preview", colon)))).toEqual({ kind: "allow" });
  });

  it("lets only GET/HEAD /healthz through without credentials, even when misconfigured", async () => {
    expect(await decidePreviewGate(ON, req("/healthz"))).toEqual({ kind: "allow" });
    expect(await decidePreviewGate(ON, req("/healthz", null, "HEAD"))).toEqual({ kind: "allow" });
    expect(await decidePreviewGate(ON, req("/healthz", null, "POST"))).toEqual({ kind: "deny", status: 401 });
    expect(await decidePreviewGate({ PREVIEW_ACCESS_GATE: "true" }, req("/healthz"))).toEqual({ kind: "allow" });
  });
});

describe("Basic header parsing and responses", () => {
  it("parses well-formed headers and rejects the rest", () => {
    expect(parseBasic(basic("preview", "a:b"))).toEqual({ user: "preview", password: "a:b" });
    expect(parseBasic(null)).toBeUndefined();
    expect(parseBasic("Basic bm9jb2xvbg==")).toBeUndefined(); // "nocolon"
    expect(parseBasic("Basic /w==")).toBeUndefined(); // invalid UTF-8
  });

  it("challenges on 401, never caches, and never echoes the secret", async () => {
    const r401 = previewGateResponse(401);
    expect(r401.status).toBe(401);
    expect(r401.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
    expect(r401.headers.get("cache-control")).toBe("no-store");
    expect(await r401.text()).not.toContain(SECRET);
    const r503 = previewGateResponse(503);
    expect(r503.status).toBe(503);
    expect(r503.headers.get("www-authenticate")).toBeNull();
  });
});
