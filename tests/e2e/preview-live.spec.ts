import { createHmac } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { API, signIn, tokens, unique } from "./helpers";

/**
 * Preview acceptance, part 2 (docs/preview-runbook.md §8, step 7): live readings on the seeded farm.
 *
 * Runs unchanged against the isolated preview (E2E_REMOTE=1) and the local stack. It leaves the seeded "Simulated field
 * feed" untouched (preview-journey.spec.ts expects it Active): each run registers its own simulation feed, sends signed
 * simulation readings for "Soil probe A (simulation)" through it, and revokes it at the end. Simulation data only.
 */
const FARM = "North orchard (simulation)";
const owner = () => ({ authorization: `Bearer ${tokens().owner}` });

async function seededFarm(request: APIRequestContext) {
  const me = await (await request.get(`${API}/v1/me`, { headers: owner() })).json();
  const tenantId = me.tenants[0].tenantId as string;
  const farms = (await (await request.get(`${API}/v1/tenants/${tenantId}/farms?limit=100`, { headers: owner() })).json()).items as { id: string; name: string }[];
  const farm = farms.find((f) => f.name === FARM);
  expect(farm, `seeded farm "${FARM}"`).toBeTruthy();
  const sensors = (await (await request.get(`${API}/v1/tenants/${tenantId}/farms/${farm!.id}/sensors`, { headers: owner() })).json()).items as { id: string; name: string }[];
  const probe = sensors.find((s) => s.name === "Soil probe A (simulation)");
  expect(probe).toBeTruthy();
  return { tenantId, farmId: farm!.id, sensorId: probe!.id };
}

async function registerFeed(request: APIRequestContext, tenantId: string, name: string) {
  const r = await request.post(`${API}/v1/tenants/${tenantId}/integrations`, {
    headers: owner(),
    data: { kind: "sensor_feed", provider: "metafarm-simulation", name, allowedEventTypes: ["sensor.readings"] },
  });
  expect(r.status()).toBe(201);
  const body = await r.json();
  return { id: body.integration.id as string, secret: body.secret as string };
}

/** One signed simulation `sensor.readings` event, as a provider sends it (x-webhook-signature over `<t>.<raw body>`). */
function postReading(request: APIRequestContext, feed: { id: string; secret: string }, sensorId: string, value: number) {
  const raw = JSON.stringify({
    scheme: "metafarm-integration-event/1",
    id: unique("acceptance").replace(/\s+/g, "-"),
    type: "sensor.readings",
    sensorId,
    readings: [{ metric: "soil_moisture", value, unit: "percent_vwc", observedAt: new Date().toISOString() }],
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", feed.secret).update(`${t}.`).update(raw).digest("hex");
  return request.post(`${API}/v1/integrations/${feed.id}/events`, { headers: { "content-type": "application/json", "x-webhook-signature": `t=${t},v1=${v1}` }, data: raw });
}

/** A one-decimal soil moisture value unlikely to be on the page already. */
const freshValue = () => 30 + Math.floor(Math.random() * 9) + (1 + Math.floor(Math.random() * 9)) / 10; // never a whole number

test.describe("preview acceptance: live readings on the seeded farm", () => {
  test.describe.configure({ mode: "serial" });

  test("a signed simulation reading appears live; polling takes over without the channel; a revoked feed is refused", async ({ page, request }) => {
    const { tenantId, farmId, sensorId } = await seededFarm(request);
    const name = unique("Acceptance feed (simulation)");
    const feed = await registerFeed(request, tenantId, name);

    // Live: the farm page subscribes over the realtime channel; the reading arrives without a reload.
    await signIn(page);
    await page.goto(`/farms/${farmId}`);
    await expect(page.getByRole("heading", { level: 1, name: FARM })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Live updates" })).toBeVisible({ timeout: 20_000 });
    const marker = await page.evaluate(() => ((window as unknown as { __noReload: number }).__noReload = Date.now()));
    const live = freshValue();
    expect((await postReading(request, feed, sensorId, live)).status()).toBe(202);
    const conditions = page.getByRole("region", { name: "Current conditions" });
    await expect(conditions).toContainText(String(live), { timeout: 30_000 });
    expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(marker);

    // Polling fallback: every realtime connection fails; the page says so and keeps updating by polling.
    await page.routeWebSocket(/\/v1\/realtime$/, (ws) => ws.close({ code: 1011, reason: "unavailable" }));
    await page.goto(`/farms/${farmId}/observations`);
    await expect(page.getByRole("status").filter({ hasText: /refreshing every 10 seconds/ })).toBeVisible({ timeout: 20_000 });
    const polled = freshValue();
    expect((await postReading(request, feed, sensorId, polled)).status()).toBe(202);
    await expect(page.getByRole("table")).toContainText(String(polled), { timeout: 45_000 });
    await page.unrouteAll({ behavior: "ignoreErrors" });

    // Revocation (confirmed in the page) is final: the next signed event is refused.
    await page.goto("/integrations");
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("article", { name }).getByRole("button", { name: /Revoke/ }).click();
    await expect(page.getByRole("article", { name })).toContainText("Revoked");
    const refused = await postReading(request, feed, sensorId, freshValue());
    expect([refused.status(), (await refused.json()).error]).toEqual([403, "integration_revoked"]);
  });
});
