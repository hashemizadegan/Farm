import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API, signIn, tokens, unique } from "./helpers";

test.describe("field tasks", () => {
  test("a manager plans repeating work and the next occurrence follows completion", async ({ page, request }) => {
    const headers = { authorization: `Bearer ${tokens().owner}` };
    const me = await (await request.get(`${API}/v1/me`, { headers })).json();
    const tenantId = me.tenants[0].tenantId as string;
    const farm = await (await request.post(`${API}/v1/tenants/${tenantId}/farms`, { headers, data: { name: unique("Task farm") } })).json();

    await signIn(page);
    await page.goto(`/farms/${farm.id}/tasks`);
    await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();

    const title = unique("Irrigate north block");
    await page.getByLabel("What needs doing").fill(title);
    await page.getByLabel("Type of work").selectOption("irrigation");
    await page.getByLabel(/Repeat every/).fill("3");
    await page.getByRole("button", { name: "Add task" }).click();

    const card = page.getByRole("article", { name: title });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Repeats every 3 days");

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);

    await card.getByRole("button", { name: /^Mark done/ }).click();
    await card.getByLabel("What was done (optional)").fill("Drip lines checked, 2 hours");
    await card.getByRole("button", { name: "Save as done" }).click();

    // The completed task leaves the open list and its next occurrence appears, three days on.
    await expect(page.getByRole("heading", { name: /Coming up/ })).toBeVisible();
    await expect(page.getByRole("article", { name: title })).toHaveCount(1);

    await page.getByRole("button", { name: "Show completed tasks" }).click();
    await expect(page.getByRole("article", { name: title })).toHaveCount(2);
    await expect(page.getByText(/Drip lines checked, 2 hours/)).toBeVisible();

    await page.goto("/schedule");
    await expect(page.getByRole("heading", { level: 1, name: "Schedule" })).toBeVisible();
    await expect(page.getByRole("link", { name: title }).first()).toBeVisible();
  });
});
