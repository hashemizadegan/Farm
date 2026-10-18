import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { API, signIn, tokens, unique } from "./helpers";

test.describe("exports", () => {
  test("downloads the stock list as a CSV", async ({ page, request }) => {
    const headers = { authorization: `Bearer ${tokens().owner}` };
    const me = await (await request.get(`${API}/v1/me`, { headers })).json();
    const tenantId = me.tenants[0].tenantId as string;
    const name = unique("Seed");
    await request.post(`${API}/v1/tenants/${tenantId}/inventory/items`, { headers, data: { name, category: "seed", unit: "kg" } });

    await signIn(page);
    await page.goto("/inventory");
    await page.getByText("Download as spreadsheet").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Current stock" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^stock_start_\d{4}-\d{2}-\d{2}\.csv$/);
    const path = await download.path();
    const body = readFileSync(path, "utf8");
    expect(body).toContain(name);
    expect(body.split("\r\n")[0]).toContain("On hand");
  });
});
