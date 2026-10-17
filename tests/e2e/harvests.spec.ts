import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API, signIn, tokens, unique } from "./helpers";

test.describe("harvest traceability", () => {
  test("a recorded batch gets a label and a public page that checks its fingerprint", async ({ page, request }) => {
    const headers = { authorization: `Bearer ${tokens().owner}` };
    const me = await (await request.get(`${API}/v1/me`, { headers })).json();
    const tenantId = me.tenants[0].tenantId as string;
    const farmName = unique("Orchard");
    const farm = await (await request.post(`${API}/v1/tenants/${tenantId}/farms`, { headers, data: { name: farmName } })).json();

    await signIn(page);
    await page.goto(`/farms/${farm.id}/harvests`);
    await expect(page.getByRole("heading", { level: 1, name: "Harvests" })).toBeVisible();

    await page.getByLabel("Crop", { exact: true }).fill("Pistachio");
    await page.getByLabel("Quantity").fill("1250.5");
    await page.getByLabel("Private notes (optional)").fill("sold to the co-op");
    await page.getByRole("button", { name: "Record batch" }).click();

    const card = page.getByRole("article").filter({ hasText: "Pistachio" }).first();
    await expect(card).toBeVisible();
    // CI has no blockchain configured, and says so plainly.
    await expect(card).toContainText("Not registered: blockchain not set up");
    const code = (await card.locator(".harvest__code").innerText()).trim();
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{10}$/);

    await card.getByRole("button", { name: /^Label and QR code/ }).click();
    await expect(card.getByRole("img", { name: new RegExp(`batch ${code}`) })).toBeVisible();

    // The public page needs no sign-in.
    const origin = new URL(page.url()).origin;
    const visitorContext = await page.context().browser()!.newContext();
    const visitor = await visitorContext.newPage();
    await visitor.goto(`${origin}/verify/${code}`);
    await expect(visitor.getByRole("heading", { level: 1 })).toContainText("Pistachio");
    await expect(visitor.getByText(farmName).first()).toBeVisible();
    await expect(visitor.getByText("The details above match the record's fingerprint.")).toBeVisible();
    await expect(visitor.getByText(/has not been registered on a blockchain/)).toBeVisible();
    await expect(visitor.getByText("sold to the co-op")).toHaveCount(0);
    const axe = await new AxeBuilder({ page: visitor }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);
    const overflow = await visitor.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await visitor.goto(`${origin}/verify/AAAAAAAAAA`);
    await expect(visitor.getByText(/no batch with this code/)).toBeVisible();
    await visitorContext.close();
  });
});
