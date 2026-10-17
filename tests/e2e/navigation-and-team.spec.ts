import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { signIn, unique } from "./helpers";

test.describe("navigation and team", () => {
  test("every main navigation link opens a real page", async ({ page }) => {
    await signIn(page);
    // Read hrefs from the DOM: on phones the menu is inside a closed drawer.
    const hrefs = await page.locator('nav[aria-label="Main"] a').evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).getAttribute("href")!));
    expect(hrefs.length).toBeGreaterThan(3);
    for (const href of [...hrefs, "/account", "/workspaces/new"]) {
      const res = await page.goto(href);
      expect(res?.status(), `${href} should not be 404`).toBeLessThan(400);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      // Nothing may be wider than the screen: phones zoom the whole page out and taps miss.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${href} is wider than the viewport`).toBeLessThanOrEqual(0);
    }
  });

  test("an admin creates an invitation link and another user joins with it", async ({ page, browser }) => {
    await signIn(page, "owner");
    await page.goto("/team");
    await expect(page.getByRole("heading", { name: /Members/ })).toBeVisible();
    await page.getByLabel("Their email address").fill(`${unique("invitee").replace(/\s+/g, "-").toLowerCase()}@example.com`);
    await page.getByLabel("Role", { exact: true }).selectOption("viewer");
    await page.getByRole("button", { name: "Create invitation link" }).click();
    const link = await page.getByLabel("Invitation link").inputValue();
    expect(link).toMatch(/\/invite#token=[A-Za-z0-9_-]{32,}/);
    await expect(page.getByRole("heading", { name: "Pending invitations" })).toBeVisible();

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);

    const other = await browser.newPage();
    await signIn(other, "invitee");
    await other.goto(link);
    await other.getByRole("button", { name: "Accept invitation" }).click();
    // The chromium and mobile projects share the invitee, so the second run finds them already a member.
    await expect(other.getByText(/You (have joined|were already a member)/)).toBeVisible();
    // The used token is removed from the address bar.
    expect(new URL(other.url()).hash).toBe("");
    await other.close();
  });
});
