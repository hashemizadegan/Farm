import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API, signIn, tokens, unique } from "./helpers";

test.describe("crop seasons", () => {
  test("a season collects its stages and the harvests from its parcel", async ({ page, request }) => {
    const headers = { authorization: `Bearer ${tokens().owner}` };
    const me = await (await request.get(`${API}/v1/me`, { headers })).json();
    const tenantId = me.tenants[0].tenantId as string;
    const farm = await (await request.post(`${API}/v1/tenants/${tenantId}/farms`, { headers, data: { name: unique("Season farm") } })).json();

    await signIn(page);
    await page.goto(`/farms/${farm.id}/seasons`);
    const form = page.getByRole("form", { name: "Start a season" });
    await form.getByLabel("Parcel (optional)").fill("Block 1");
    await form.getByLabel("Crop", { exact: true }).fill("Wheat");
    await form.getByLabel("Area in hectares (optional)").fill("2.5");
    await form.getByRole("button", { name: "Start season" }).click();

    await page.getByRole("link", { name: "Wheat" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Wheat" })).toBeVisible();
    const stage = page.getByRole("form", { name: "Record a stage" });
    await stage.getByLabel("Stage").selectOption("sowing");
    await stage.getByRole("button", { name: "Record stage" }).click();
    await expect(page.getByRole("list").filter({ hasText: "Sowing or planting" }).first()).toBeVisible();

    // A harvest recorded on the parcel joins the active season automatically.
    await request.post(`${API}/v1/tenants/${tenantId}/farms/${farm.id}/harvests`, {
      headers,
      data: { cropName: "Wheat", parcelLabel: "Block 1", harvestedOn: new Date().toISOString().slice(0, 10), quantity: "1250", unit: "kg" },
    });
    await page.reload();
    await expect(page.getByText(/Per hectare: 500 kg/)).toBeVisible();

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);
  });
});
