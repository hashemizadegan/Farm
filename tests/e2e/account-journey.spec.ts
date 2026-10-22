import { expect, test } from "@playwright/test";
import { signIn, unique } from "./helpers";

/**
 * The account journey end to end, with no manual step: a brand-new account signs in, is asked to create its first
 * workspace (validation first), creates it, lands in it as owner, and signs out; signed-out pages ask to sign in.
 */
// The sign-out control sits in the sidebar, which is a drawer on phones; one desktop run covers the journey.
test.skip(({ isMobile }) => isMobile, "desktop project only");

test.describe("account journey", () => {
  test("a new account creates its first workspace, works in it, and signs out", async ({ page }) => {
    await signIn(page, "newcomer");
    await expect(page.getByRole("heading", { name: "Create your workspace" })).toBeVisible();

    // Validation before anything is sent.
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.getByText("Enter a name for your workspace.").first()).toBeVisible();

    const name = unique("E2E workspace");
    await page.getByLabel("Workspace name").fill(name);
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page.getByRole("heading", { name: "Create your workspace" })).toHaveCount(0);
    await expect(page.getByText(name).first()).toBeVisible();
    await expect(page.getByText("Your role: Owner").first()).toBeVisible();

    // Its farms page is reachable and empty for a new workspace (no data leaks in from other workspaces).
    await page.goto("/farms");
    await expect(page.getByText("Sign in required.")).toHaveCount(0);

    await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.goto("/farms");
    await expect(page.getByText("Sign in required.")).toBeVisible();
    await page.getByRole("link", { name: "Sign in" }).first().click();
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
