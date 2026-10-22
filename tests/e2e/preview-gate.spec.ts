import { expect, test, type APIRequestContext } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * Private-preview access gate, end to end in a real server:
 * - local/CI: a second web server started with the gate on (E2E_GATED_WEB_URL, see playwright.config.ts);
 * - remote (E2E_REMOTE=1): the deployed preview itself (E2E_WEB_URL), plus its API (E2E_API_URL).
 * Needs E2E_PREVIEW_ACCESS_PASSWORD (the gate's password). Skipped when no gated target is configured.
 */
const REMOTE = process.env.E2E_REMOTE === "1";
const TARGET = REMOTE ? process.env.E2E_WEB_URL : process.env.E2E_GATED_WEB_URL;
const PASSWORD = process.env.E2E_PREVIEW_ACCESS_PASSWORD;
const API = process.env.E2E_API_URL ?? "http://localhost:4000";
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const D39_PREFIX = "SIMULATION ONLY:";

test.skip(!TARGET || !PASSWORD, "no gated web target configured (E2E_GATED_WEB_URL or E2E_REMOTE + E2E_WEB_URL, and E2E_PREVIEW_ACCESS_PASSWORD)");
// One project is enough: the gate does not depend on the device.
test.skip(({ isMobile }) => isMobile, "desktop project only");

/** A static asset URL from the gated home page (fetched with credentials). */
async function someAsset(request: APIRequestContext): Promise<string> {
  const html = await (await request.get(`${TARGET}/`, { headers: { authorization: basic("preview", PASSWORD!) } })).text();
  const m = /\/_next\/static\/[^"'\s]+\.js/.exec(html);
  expect(m, "the gated home page references a Next.js asset").not.toBeNull();
  return m![0];
}

test.describe("preview access gate", () => {
  test("refuses pages and assets without credentials, with a Basic challenge", async ({ request }) => {
    const asset = await someAsset(request);
    for (const path of ["/", "/yield", "/sign-in", "/offline", "/manifest.webmanifest", asset]) {
      const r = await request.get(`${TARGET}${path}`, { maxRedirects: 0 });
      expect(r.status(), path).toBe(401);
      expect(r.headers()["www-authenticate"], path).toMatch(/^Basic realm=/);
      expect(r.headers()["cache-control"], path).toBe("no-store");
      expect(await r.text(), path).not.toContain(PASSWORD!);
    }
  });

  test("refuses wrong credentials and serves the health check without any", async ({ request }) => {
    for (const authorization of [basic("preview", `${PASSWORD}x`), basic("admin", PASSWORD!), `Bearer ${PASSWORD}`]) {
      expect((await request.get(`${TARGET}/`, { headers: { authorization } })).status()).toBe(401);
    }
    const health = await request.get(`${TARGET}/healthz`);
    expect(health.status()).toBe(200);
    expect(await health.text()).toBe("ok");
  });

  test("admits the right credentials: sign-in, then /yield with the D-39 banner", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: TARGET, httpCredentials: { username: "preview", password: PASSWORD!, origin: new URL(TARGET!).origin, send: "always" } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await signIn(page, "owner");
    // A deployed preview always has the yield pages; locally they follow the build's switch.
    if (REMOTE || process.env.NEXT_PUBLIC_YIELD_PAGES_ENABLED === "true") {
      await page.goto("/yield");
      await expect(page.locator("[data-disclosure]")).toContainText(D39_PREFIX);
      await expect(page.locator("[data-disclosure]")).toHaveAttribute("lang", "en");
    }
    expect(errors).toEqual([]);
    await context.close();
  });

  test("remote only: the preview API refuses unauthenticated requests except health checks", async ({ request }) => {
    test.skip(!REMOTE, "the local API runs without its gate");
    for (const path of ["/v1/me", "/docs", "/no-such-route"]) expect((await request.get(`${API}${path}`)).status(), path).toBe(401);
    expect((await request.get(`${API}/healthz`)).status()).toBe(200);
  });
});
