import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API, signIn, tokens, unique } from "./helpers";

test.describe("offline field use", () => {
  test("a task completed without signal is kept on the phone and sent when back online", async ({ page, context, request }) => {
    const headers = { authorization: `Bearer ${tokens().owner}` };
    const me = await (await request.get(`${API}/v1/me`, { headers })).json();
    const tenantId = me.tenants[0].tenantId as string;
    const farm = await (await request.post(`${API}/v1/tenants/${tenantId}/farms`, { headers, data: { name: unique("Offline farm") } })).json();
    const title = unique("Check drip lines");
    const task = await (
      await request.post(`${API}/v1/tenants/${tenantId}/farms/${farm.id}/tasks`, { headers, data: { title, kind: "irrigation", dueDate: "2026-10-18" } })
    ).json();

    await signIn(page);
    await page.goto(`/farms/${farm.id}/tasks`);
    const card = page.getByRole("article", { name: title });
    await expect(card).toBeVisible();

    await context.setOffline(true);
    await expect(page.getByText(/You're offline/)).toBeVisible();
    await card.getByRole("button", { name: /^Mark done/ }).click();
    await card.getByLabel("What was done (optional)").fill("Flushed line 3");
    await card.getByRole("button", { name: "Save as done" }).click();
    await expect(card.getByText("Saved on this phone")).toBeVisible();
    await expect(page.getByText("1 record is waiting to be sent.")).toBeVisible();

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);

    await context.setOffline(false);
    await expect(page.getByText("1 record is waiting to be sent.")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(/You're offline/)).toHaveCount(0);

    const saved = await (await request.get(`${API}/v1/tenants/${tenantId}/farms/${farm.id}/tasks?status=all`, { headers })).json();
    const done = saved.items.find((t: { id: string }) => t.id === task.id);
    expect(done).toMatchObject({ status: "done", completionNote: "Flushed line 3" });
  });

  test("the app can be installed", async ({ page }) => {
    const res = await page.request.get("/manifest.webmanifest");
    expect(res.ok()).toBe(true);
    const manifest = await res.json();
    expect(manifest).toMatchObject({ display: "standalone", start_url: "/tasks" });
    expect((await page.request.get("/icons/icon-512.png")).ok()).toBe(true);
    expect((await page.request.get("/sw.js")).ok()).toBe(true);
  });
});
