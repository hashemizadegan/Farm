import { createHmac } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { API, signIn, tokens, unique } from "./helpers";

/**
 * Connected journeys over the e2e stack (REALTIME_EVENTS_ENABLED, INTEGRATION_SECRET_KEY and NEXT_PUBLIC_REALTIME_URL
 * are set for APP_ENV=test only; see .github/workflows/ci.yml):
 * an admin registers an integration in the web app; its signed readings go through the existing pipeline (API, worker)
 * and appear on the observations page without a reload (realtime), or by polling when the channel is unavailable;
 * revocation stops ingestion; members without integration:manage get neither controls nor data.
 */
const owner = () => ({ authorization: `Bearer ${tokens().owner}` });

async function workspaceFarmAndSensor(request: APIRequestContext) {
  const me = await (await request.get(`${API}/v1/me`, { headers: owner() })).json();
  const tenantId = me.tenants[0].tenantId as string;
  const farmName = unique("Feed farm");
  const farm = await (await request.post(`${API}/v1/tenants/${tenantId}/farms`, { headers: owner(), data: { name: farmName } })).json();
  const sensorName = unique("Feed probe");
  const created = await (await request.post(`${API}/v1/tenants/${tenantId}/farms/${farm.id}/sensors`, { headers: owner(), data: { name: sensorName, kind: "soil-moisture" } })).json();
  return { tenantId, farmId: farm.id as string, farmName, sensorId: created.sensor.id as string, sensorName };
}

/** One signed `sensor.readings` event, exactly as a provider would send it. */
function postReading(request: APIRequestContext, integration: { id: string; secret: string }, sensorId: string, value: number) {
  const raw = JSON.stringify({
    scheme: "metafarm-integration-event/1",
    id: unique("evt").replace(/\s+/g, "-"),
    type: "sensor.readings",
    sensorId,
    readings: [{ metric: "soil_moisture", value, unit: "percent_vwc", observedAt: new Date().toISOString() }],
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", integration.secret).update(`${t}.`).update(raw).digest("hex");
  return request.post(`${API}/v1/integrations/${integration.id}/events`, { headers: { "content-type": "application/json", "x-webhook-signature": `t=${t},v1=${v1}` }, data: raw });
}

test.describe("registered integrations and live updates", () => {
  test("an admin registers an integration; its readings appear live; revocation stops ingestion", async ({ page, request }) => {
    const { tenantId, farmId, sensorId } = await workspaceFarmAndSensor(request);
    const name = unique("Acme probes");

    await signIn(page);
    await page.goto("/integrations");
    const form = page.getByRole("form", { name: "Register an integration" });
    await form.getByRole("button", { name: "Register integration" }).click();
    await expect(page.getByText("Enter a name.").first()).toBeVisible();
    await form.getByLabel("Name").fill(name);
    await form.getByLabel("Provider identifier").fill("acme-probes");
    await form.getByRole("button", { name: "Register integration" }).click();

    // Shown once, acknowledged explicitly, then gone; never kept in browser storage.
    const secret = await page.getByRole("textbox", { name: "Signing secret" }).inputValue();
    expect(secret).toMatch(/^mfi_[A-Za-z0-9_-]{43}$/);
    const done = page.getByRole("button", { name: "Done" });
    await expect(done).toBeDisabled();
    await page.getByLabel("I have stored the secret somewhere safe").check();
    await done.click();
    await expect(page.getByRole("textbox", { name: "Signing secret" })).toHaveCount(0);
    const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage)));
    expect(stored).not.toContain(secret.slice(4));
    await expect(page.getByRole("article", { name })).toContainText("Active");

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);

    const list = await (await request.get(`${API}/v1/tenants/${tenantId}/integrations`, { headers: owner() })).json();
    const integration = { id: list.items.find((i: { name: string }) => i.name === name).id as string, secret };

    // Live: the page subscribes over the realtime channel; while live it polls only once a minute.
    await page.goto(`/farms/${farmId}/observations`);
    await expect(page.getByRole("status").filter({ hasText: "Live updates" })).toBeVisible({ timeout: 15_000 });
    expect((await postReading(request, integration, sensorId, 31.7)).status()).toBe(202);
    // API → raw observation → worker normalization → observation.recorded → page reload of the list, no navigation.
    await expect(page.getByRole("table")).toContainText("31.7", { timeout: 20_000 });

    // Revocation (confirmed) is final: the next signed event is refused.
    await page.goto("/integrations");
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("article", { name }).getByRole("button", { name: /Revoke/ }).click();
    await expect(page.getByRole("article", { name })).toContainText("Revoked");
    const refused = await postReading(request, integration, sensorId, 12);
    expect([refused.status(), (await refused.json()).error]).toEqual([403, "integration_revoked"]);
  });

  test("when the realtime channel is unavailable the page says so and keeps updating by polling", async ({ page, request }) => {
    const { tenantId, farmId, sensorId } = await workspaceFarmAndSensor(request);
    const r = await (
      await request.post(`${API}/v1/tenants/${tenantId}/integrations`, { headers: owner(), data: { kind: "sensor_feed", provider: "acme-probes", name: unique("Polling probes"), allowedEventTypes: ["sensor.readings"] } })
    ).json();
    // Every realtime connection attempt fails (as when the channel is off or unreachable).
    await page.routeWebSocket(/\/v1\/realtime$/, (ws) => ws.close({ code: 1011, reason: "unavailable" }));
    await signIn(page);
    await page.goto(`/farms/${farmId}/observations`);
    await expect(page.getByRole("status").filter({ hasText: /refreshing every 10 seconds/ })).toBeVisible({ timeout: 15_000 });
    expect((await postReading(request, { id: r.integration.id, secret: r.secret }, sensorId, 27.3)).status()).toBe(202);
    await expect(page.getByRole("table")).toContainText("27.3", { timeout: 30_000 });
  });

  test("farm operations: farm → current conditions → an observation's source → the integration feeding the farm", async ({ page, request }) => {
    const { tenantId, farmId, farmName, sensorId, sensorName } = await workspaceFarmAndSensor(request);
    const feedName = unique("Field feed");
    const r = await (
      await request.post(`${API}/v1/tenants/${tenantId}/integrations`, { headers: owner(), data: { kind: "sensor_feed", provider: "acme-probes", name: feedName, allowedEventTypes: ["sensor.readings"] } })
    ).json();
    expect((await postReading(request, { id: r.integration.id, secret: r.secret }, sensorId, 44.2)).status()).toBe(202);
    // The worker normalizes the reading before the journey starts.
    await expect(async () => {
      const items = (await (await request.get(`${API}/v1/tenants/${tenantId}/farms/${farmId}/observations`, { headers: owner() })).json()).items;
      expect(items.length).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000 });

    await signIn(page);
    await page.goto("/farms");
    await page.getByRole("link", { name: farmName }).click();
    const conditions = page.getByRole("region", { name: "Current conditions" });
    await expect(conditions).toContainText(sensorName);
    await expect(conditions).toContainText("Reporting");
    await expect(conditions).toContainText(/Last observation /);
    await conditions.getByRole("link", { name: /Soil moisture: 44\.2/ }).click();

    await expect(page.getByRole("heading", { name: "Observation: Soil moisture" })).toBeVisible();
    const source = page.getByRole("region", { name: /Source/ });
    await expect(source).toContainText("Registered integration");
    await expect(source).toContainText(feedName);
    await expect(source).toContainText(sensorName);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);

    await source.getByRole("link", { name: "Manage this integration" }).click();
    await expect(page).toHaveURL(new RegExp(`/integrations\\?farmId=${farmId}`));
    await expect(page.getByText(`Showing the integrations that have delivered observations to ${farmName}.`)).toBeVisible();
    await expect(page.getByRole("article", { name: feedName })).toContainText("Active");
  });

  test("members without integration:manage get neither the controls nor the data", async ({ page, request }) => {
    const me = await (await request.get(`${API}/v1/me`, { headers: owner() })).json();
    const tenantId = me.tenants[0].tenantId as string;
    const invitation = await (
      await request.post(`${API}/v1/tenants/${tenantId}/invitations`, { headers: owner(), data: { email: `${unique("viewer").replace(/\s+/g, "-").toLowerCase()}@example.com`, role: "viewer" } })
    ).json();
    const viewer = { authorization: `Bearer ${tokens().invitee}` };
    expect((await request.post(`${API}/v1/me/invitations/accept`, { headers: viewer, data: { token: invitation.token } })).status()).toBe(200);
    expect((await request.get(`${API}/v1/tenants/${tenantId}/integrations`, { headers: viewer })).status()).toBe(403);

    await signIn(page, "invitee");
    await page.goto("/integrations");
    await expect(page.getByText("Only workspace admins and owners can manage integrations.")).toBeVisible();
    await expect(page.getByRole("form", { name: "Register an integration" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Integrations" })).toHaveCount(0);
  });
});
