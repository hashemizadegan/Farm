import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Review screenshots of the deployed preview (E2E_SCREENSHOTS=1 with E2E_REMOTE=1; skipped otherwise).
 *
 * Signs in exactly as a human reviewer does (HTTP Basic "preview" + PREVIEW_ACCESS_PASSWORD from the browser context,
 * then a development token minted with the dependency-free recipe in docs/preview-runbook.md §5), opens four pages and
 * writes each screenshot to tests/review-shots/ (scripts/upload-review-shots.mjs uploads them), logging the page URL. The image shows
 * the page only: no password or token is on screen once signed in. Nothing is created or changed.
 */
const ON = process.env.E2E_REMOTE === "1" && process.env.E2E_SCREENSHOTS === "1";
const FARM = "North orchard (simulation)";

/** The runbook's reviewer recipe: HS256, iss "dev", aud "metafarm-dev", 8 hours. */
function reviewerToken(secret: string, subject = "dev-user"): string {
  const b = (x: object) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const n = Math.floor(Date.now() / 1000);
  const h = `${b({ alg: "HS256" })}.${b({ name: subject, iss: "dev", aud: "metafarm-dev", sub: subject, iat: n, exp: n + 28800 })}`;
  return `${h}.${createHmac("sha256", secret).update(h).digest("base64url")}`;
}

const OUT = path.resolve(import.meta.dirname, "../review-shots");

/** Writes the page to tests/review-shots/<name>.jpg (uploaded by scripts/upload-review-shots.mjs) and logs its URL. */
async function emit(page: Page, name: string) {
  await page.waitForLoadState("networkidle");
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, `${name}.jpg`), await page.screenshot({ type: "jpeg", quality: 80, fullPage: true }));
  console.log(`SHOT ${name} ${page.url()} commit=${(process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown").slice(0, 7)} at=${new Date().toISOString()}`);
}

test.skip(!ON, "review screenshots: E2E_REMOTE=1 and E2E_SCREENSHOTS=1 only");
test.skip(({ isMobile }) => isMobile, "desktop screenshots only");
test.use({ viewport: { width: 1366, height: 860 } });

test("review screenshots of the deployed preview", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/sign-in");
  await page.getByLabel("Development token").fill(reviewerToken(process.env.DEV_AUTH_SECRET!));
  await page.getByRole("button", { name: "Sign in" }).press("Enter");
  await page.waitForURL((u) => u.pathname === "/");

  await page.goto("/yield");
  await expect(page.locator("[data-disclosure]")).toBeVisible();
  await emit(page, "1-yield");

  await page.goto("/farms");
  await page.getByRole("link", { name: FARM }).click();
  const conditions = page.getByRole("region", { name: "Current conditions" });
  for (const state of ["Reporting", "Silent", "Waiting for first reading", "Disabled"]) await expect(conditions).toContainText(state);
  await emit(page, "2-north-orchard");

  const farmPath = new URL(page.url()).pathname;
  await page.goto(`${farmPath}/observations`);
  await page.getByRole("row").filter({ hasText: "Soil moisture" }).filter({ hasText: "23.4" }).getByRole("link").click();
  await expect(page.getByRole("region", { name: /Source/ })).toContainText("Registered integration");
  await emit(page, "3-observation-source");

  await page.getByRole("region", { name: /Source/ }).getByRole("link", { name: "Manage this integration" }).click();
  await expect(page.getByText(`Showing the integrations that have delivered observations to ${FARM}.`)).toBeVisible();
  await emit(page, "4-integrations-filtered");
});
