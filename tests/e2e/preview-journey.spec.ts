import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * The preview acceptance journey over the seeded simulation data only (apps/api/src/scripts/seed-farm-operations.ts:
 * `pnpm seed:farm-ops` locally and in CI, step 3 of the preview seed runner): it creates nothing, so it runs unchanged
 * against an isolated preview (E2E_REMOTE=1) as well as the local stack.
 *
 * sign in → the workspace's farms → "North orchard (simulation)" → current conditions (every freshness state) → an
 * observation from the registered integration → its source → the integration feeding the farm; and a person's note.
 */
const FARM = "North orchard (simulation)";

test.describe("preview acceptance: farm operations", () => {
  test("from the farm list to the integration feeding the farm", async ({ page }) => {
    await signIn(page);
    // The workspace is selected on sign-in (one workspace); its farms are one link away.
    await page.goto("/farms");
    await page.getByRole("link", { name: FARM }).click();
    await expect(page.getByRole("heading", { level: 1, name: FARM })).toBeVisible();

    const conditions = page.getByRole("region", { name: "Current conditions" });
    const sensor = (name: string) => conditions.getByRole("listitem").filter({ hasText: name }).first();
    await expect(sensor("Soil probe A (simulation)")).toContainText("Reporting");
    await expect(sensor("Soil probe B (simulation)")).toContainText("Silent");
    await expect(sensor("Weather mast (simulation)")).toContainText("Waiting for first reading");
    await expect(sensor("Rain gauge (simulation)")).toContainText("Disabled");
    await expect(conditions).toContainText(/Last observation /);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);

    // The newest integration reading: its detail and source.
    await conditions.getByRole("link", { name: /Soil moisture: 23\.4/ }).click();
    await expect(page.getByRole("heading", { name: "Observation: Soil moisture" })).toBeVisible();
    const source = page.getByRole("region", { name: /Source/ });
    await expect(source).toContainText("Registered integration");
    await expect(source).toContainText("Simulated field feed");
    await expect(source).toContainText("simulation-2");
    await expect(source).toContainText("Soil probe A (simulation)");

    // Manage the integration that delivered it: the integrations page, filtered to this farm.
    await source.getByRole("link", { name: "Manage this integration" }).click();
    await expect(page.getByText(`Showing the integrations that have delivered observations to ${FARM}.`)).toBeVisible();
    await expect(page.getByRole("article", { name: "Simulated field feed" })).toContainText("Active");
    await expect(page.getByRole("article", { name: "Simulated field feed" }).getByRole("button", { name: /Rotate secret/ })).toBeVisible();
  });

  test("a person's note shows who entered it", async ({ page }) => {
    await signIn(page);
    await page.goto("/farms");
    await page.getByRole("link", { name: FARM }).click();
    await expect(page.getByRole("heading", { level: 1, name: FARM })).toBeVisible();
    // The full list, not "Latest observations" (five rows): later readings (preview-live.spec.ts) push the note out of it.
    await page.goto(`${new URL(page.url()).pathname}/observations`);
    await page.getByRole("row").filter({ hasText: "Drip line in block 1 checked" }).getByRole("link").click();
    const source = page.getByRole("region", { name: /Source/ });
    await expect(source).toContainText("Entered by a person");
    // The person's current display name (sign-in may update it); never an integration or a sensor.
    await expect(source.getByRole("definition").first()).not.toBeEmpty();
    await expect(source).not.toContainText("Registered integration");
    await expect(source).not.toContainText("Sensor");
  });
});
