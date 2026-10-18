import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { signIn, unique } from "./helpers";

test.describe("equipment", () => {
  test("a machine with an hour meter gets a maintenance plan that falls due and is serviced", async ({ page }) => {
    const name = unique("Blue tractor");
    await signIn(page);
    await page.goto("/equipment");
    await expect(page.getByRole("heading", { level: 1, name: "Equipment" })).toBeVisible();

    const add = page.getByRole("form", { name: "Add a machine" });
    await add.getByLabel("Name").fill(name);
    await add.getByLabel("Hour meter now").fill("1240");
    await add.getByRole("button", { name: "Add machine" }).click();
    await page.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

    const plan = page.getByRole("form", { name: "Add a maintenance plan" });
    await plan.getByLabel("What to do").fill("Engine oil");
    await plan.getByLabel("Every … hours (optional)").fill("50");
    await plan.getByLabel("Hour meter when last done").fill("1190");
    await plan.getByRole("button", { name: "Add plan" }).click();
    const card = page.getByRole("article", { name: "Engine oil" });
    await expect(card).toContainText("Service overdue");

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);

    const svc = page.getByRole("form", { name: "Record a service or repair" });
    await svc.getByLabel("For plan (optional)").selectOption({ label: "Engine oil" });
    await svc.getByLabel("Hour meter (optional)").fill("1241");
    await svc.getByRole("button", { name: "Record service" }).click();
    await expect(page.getByRole("article", { name: "Engine oil" })).toContainText("Up to date");
  });
});
