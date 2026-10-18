import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API, signIn, tokens, unique } from "./helpers";

test.describe("live sensors", () => {
  test("a registered device sends readings that appear on the farm", async ({ page, request }) => {
    const headers = { authorization: `Bearer ${tokens().owner}` };
    const me = await (await request.get(`${API}/v1/me`, { headers })).json();
    const tenantId = me.tenants[0].tenantId as string;
    const farm = await (await request.post(`${API}/v1/tenants/${tenantId}/farms`, { headers, data: { name: unique("Sensor farm") } })).json();

    await signIn(page);
    await page.goto(`/farms/${farm.id}/sensors`);
    const form = page.getByRole("form", { name: "Register a sensor" });
    await form.getByLabel("Name").fill("Block 1 probe");
    await form.getByRole("button", { name: "Register sensor" }).click();

    const token = await page.getByLabel("Device token").inputValue();
    expect(token).toMatch(/^mfs_/);
    await expect(page.getByText(/shown only once/)).toBeVisible();
    await page.getByRole("button", { name: "I have saved the token" }).click();
    await expect(page.getByLabel("Device token")).toHaveCount(0);

    const sent = await request.post(`${API}/v1/ingest/readings`, {
      headers: { authorization: `Sensor ${token}` },
      data: { readings: [{ metric: "soil_moisture", value: 23.4, unit: "percent_vwc", observedAt: new Date().toISOString() }] },
    });
    expect(sent.status()).toBe(202);

    // The worker normalises the reading; the page polls.
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("article", { name: "Block 1 probe" })).toContainText("23.4", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByRole("article", { name: "Block 1 probe" })).toContainText("Reporting");

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);
  });
});
