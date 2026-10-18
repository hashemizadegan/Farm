import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API, signIn, tokens, unique } from "./helpers";

test.describe("notifications", () => {
  test("low stock reaches the manager's inbox and can be marked read", async ({ page, request }) => {
    const headers = { authorization: `Bearer ${tokens().owner}` };
    const me = await (await request.get(`${API}/v1/me`, { headers })).json();
    const tenantId = me.tenants[0].tenantId as string;
    const farm = await (await request.post(`${API}/v1/tenants/${tenantId}/farms`, { headers, data: { name: unique("Stock farm") } })).json();
    const name = unique("Urea");
    const item = await (
      await request.post(`${API}/v1/tenants/${tenantId}/inventory/items`, { headers, data: { name, category: "fertilizer", unit: "kg", reorderLevel: "5" } })
    ).json();
    const move = (data: object) => request.post(`${API}/v1/tenants/${tenantId}/inventory/movements`, { headers, data: { itemId: item.id, occurredOn: "2026-10-18", ...data } });
    await move({ kind: "receive", quantity: "6" });
    await move({ kind: "use", quantity: "2", farmId: farm.id });

    await signIn(page);
    await page.goto("/notifications");
    await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
    await expect(page.getByText(`${name} is low: 4 kg left.`)).toBeVisible();

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);

    await page.getByRole("button", { name: "Mark all read" }).click();
    await expect(page.getByRole("button", { name: "Mark all read" })).toHaveCount(0);
    await expect(page.locator('a[href="/notifications"][aria-label="Notifications"]').first()).toBeAttached();
  });
});
