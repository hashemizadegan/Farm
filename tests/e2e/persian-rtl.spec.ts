import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

/** On phones the language switch sits in the menu drawer. */
async function openMenuIfCollapsed(page: Page, name: string) {
  const menu = page.getByRole("button", { name, exact: true });
  if (await menu.isVisible()) await menu.click();
}

test.describe("Persian (فارسی) and right-to-left layout", () => {
  test("the language switch translates the app and mirrors the layout", async ({ page }) => {
    await signIn(page);
    await openMenuIfCollapsed(page, "Menu");
    await page.getByRole("button", { name: "فارسی" }).click();

    const html = page.locator("html");
    await expect(html).toHaveAttribute("lang", "fa");
    await expect(html).toHaveAttribute("dir", "rtl");

    for (const href of ["/", "/farms", "/farms/new", "/team", "/settings", "/account", "/assets", "/about/disclosures"]) {
      await page.goto(href);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      // Mirroring must not push anything past the screen edge.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${href} is wider than the viewport in Persian`).toBeLessThanOrEqual(0);
    }

    await page.goto("/farms");
    await expect(page.getByRole("heading", { level: 1, name: "مزرعه‌ها" })).toBeVisible();
    // CSS selector: on phones the navigation is in the closed (hidden) drawer.
    await expect(page.locator('nav[aria-label="اصلی"]')).toBeAttached();
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);

    // The choice is remembered, and switching back restores English left-to-right.
    await page.reload();
    await expect(html).toHaveAttribute("dir", "rtl");
    await openMenuIfCollapsed(page, "منو");
    await page.getByRole("button", { name: "English" }).click();
    await expect(html).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("heading", { level: 1, name: "Farms" })).toBeVisible();
  });

  test("the sign-in page offers the language before signing in", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "فارسی" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("هر مزرعه با مرزش آغاز می‌شود.");
  });
});
