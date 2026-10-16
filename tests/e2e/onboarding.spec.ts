import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { randomCoords, signIn, unique } from "./helpers";

test.describe("farm onboarding", () => {
  test("creates a farm from coordinates and shows a user-entered boundary that becomes valid", async ({ page }) => {
    await signIn(page);
    await page.getByRole("link", { name: "Create a farm project" }).click();

    const name = unique("E2E farm");
    const { lat, lon } = randomCoords();
    await page.getByLabel("Farm project name").fill(name);
    await page.getByLabel(/Enter GPS coordinates/).check();
    await page.getByLabel("Latitude (decimal degrees)").fill(lat);
    await page.getByLabel("Longitude (decimal degrees)").fill(lon);
    await expect(page.getByText(/Looks valid/)).toBeVisible();
    await page.getByRole("button", { name: "Create farm and submit boundary" }).click();

    await page.waitForURL(/\/farms\/[0-9a-f-]+\/boundary$/);
    await expect(page.getByRole("heading", { name: "Boundary review" })).toBeVisible();
    await expect(page.getByText("User-entered").first()).toBeVisible();
    // The worker validates in PostGIS; the page polls and updates.
    await expect(page.getByTestId("validation-status")).toHaveText("Valid", { timeout: 30_000 });
  });

  test("rejects a self-intersecting drawn boundary with an accessible error summary", async ({ page }) => {
    await signIn(page);
    await page.goto("/farms/new");
    await page.getByLabel("Farm project name").fill(unique("Bad shape"));
    await page.getByLabel(/Draw on the map/).check();
    const corners: [string, string][] = [
      ["0", "0"],
      ["0.001", "0.001"],
      ["0", "0.001"],
      ["0.001", "0"],
    ];
    for (const [la, lo] of corners) {
      await page.getByLabel("Corner latitude").fill(la);
      await page.getByLabel("Corner longitude").fill(lo);
      await page.getByRole("button", { name: "Add corner" }).click();
    }
    await page.getByRole("button", { name: "Create farm and submit boundary" }).click();
    const summary = page.locator("[data-error-summary]");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(/intersect/);
    await expect(summary).toBeFocused();
  });

  test("onboarding page has no detectable WCAG 2.2 A/AA violations", async ({ page }) => {
    await signIn(page);
    await page.goto("/farms/new");
    // The map canvas is excluded: its content is mirrored by the text form on the same page.
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-testid=boundary-map]")
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
