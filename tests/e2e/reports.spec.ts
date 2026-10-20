import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API, signIn, tokens, unique } from "./helpers";

test.describe("reports", () => {
  test("a manager sees this week's work, inputs and harvests for a farm", async ({ page, request }) => {
    const headers = { authorization: `Bearer ${tokens().owner}` };
    const me = await (await request.get(`${API}/v1/me`, { headers })).json();
    const tenantId = me.tenants[0].tenantId as string;
    const farmName = unique("Report farm");
    const farm = await (await request.post(`${API}/v1/tenants/${tenantId}/farms`, { headers, data: { name: farmName } })).json();
    const today = new Date().toISOString().slice(0, 10);
    const task = await (
      await request.post(`${API}/v1/tenants/${tenantId}/farms/${farm.id}/tasks`, { headers, data: { title: "Weed row 2", kind: "weeding", dueDate: today } })
    ).json();
    await request.post(`${API}/v1/tenants/${tenantId}/farms/${farm.id}/tasks/${task.id}/complete`, { headers, data: {} });
    await request.post(`${API}/v1/tenants/${tenantId}/farms/${farm.id}/harvests`, {
      headers,
      data: { cropName: "Saffron", harvestedOn: today, quantity: "1.5", unit: "kg" },
    });

    await signIn(page);
    await page.goto("/reports");
    await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
    await page.getByLabel("Farm", { exact: true }).selectOption({ label: farmName });
    await page.getByLabel("Period").selectOption("last30");

    const report = page.getByRole("article");
    await expect(report.getByRole("heading", { level: 2, name: new RegExp(farmName) })).toBeVisible();
    await expect(report.getByText("1 task completed.")).toBeVisible();
    await expect(report.getByRole("rowheader", { name: "Weeding" })).toBeVisible();
    await expect(report.getByRole("row", { name: /Saffron\s+1\.5 kg\s+1/ })).toBeVisible();

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);
  });
});
