import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API, signIn, tokens, unique } from "./helpers";

test.describe("inputs and stock", () => {
  test("a delivery, a recorded application, the stock level and the pre-harvest warning", async ({ page, request }) => {
    const headers = { authorization: `Bearer ${tokens().owner}` };
    const me = await (await request.get(`${API}/v1/me`, { headers })).json();
    const tenantId = me.tenants[0].tenantId as string;
    const farm = await (await request.post(`${API}/v1/tenants/${tenantId}/farms`, { headers, data: { name: unique("Input farm") } })).json();
    const product = unique("Copper oxychloride");

    await signIn(page);
    await page.goto("/inventory");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();

    const add = page.getByRole("form", { name: "Add an input" });
    await add.getByLabel("Name").fill(product);
    await add.getByLabel("Category").selectOption("crop-protection");
    await add.getByLabel("Pre-harvest interval in days (optional)").fill("14");
    await add.getByRole("button", { name: "Add input" }).click();
    await expect(page.getByRole("rowheader", { name: new RegExp(product) })).toBeVisible();

    const move = page.getByRole("form", { name: "Record a delivery or stock correction" });
    await move.getByLabel("Input").selectOption({ label: `${product} (kg)` });
    await move.getByLabel(/^Quantity/).fill("10");
    await move.getByRole("button", { name: "Record" }).click();
    await expect(page.getByRole("row", { name: new RegExp(product) }).first()).toContainText("10 kg");

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);

    await page.goto(`/farms/${farm.id}/inputs`);
    const use = page.getByRole("form", { name: "Record inputs used" });
    await use.getByLabel("Input").selectOption({ label: `${product} (kg)` });
    await use.getByLabel(/^Quantity/).fill("1.5");
    await use.getByLabel("Parcel (optional)").fill("Block 3");
    await use.getByRole("button", { name: "Record use" }).click();
    await expect(page.getByRole("row", { name: new RegExp(product) })).toContainText("Block 3");
    await expect(page.getByText(/No harvest before/)).toBeVisible();

    await page.goto("/inventory");
    await expect(page.getByRole("row", { name: new RegExp(product) }).first()).toContainText("8.5 kg");

    // Harvesting the sprayed parcel today is flagged.
    await page.goto(`/farms/${farm.id}/harvests`);
    await page.getByLabel("Parcel (optional)").fill("Block 3");
    await expect(page.getByText("Pre-harvest interval not over")).toBeVisible();
  });
});
