import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * Y10 operator pages (`/yield`) on the full stack with simulation data: the D-39 banner on every view, cycle states,
 * four-eyes, the calculation dossier, carry-forward and the unsigned claim intents built from stored leaves. Fails on
 * any console error or uncaught page error (hydration problems included). Screenshots go to tests/yield-screenshots.
 *
 * Needs NEXT_PUBLIC_YIELD_PAGES_ENABLED (web build) and YIELD_WORKFLOW_ENABLED + YIELD_CLAIM_INTENTS_ENABLED (API), as
 * the CI e2e job sets them (APP_ENV=test; all three stay off by default and refused when deployed).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const shots = path.join(root, "tests", "yield-screenshots");
const D39 =
  "Yield metrics, cycles, and claim intents displayed in this interface are generated from deterministic simulation models. No real assets, mainnet signatures, or monetary liabilities are incurred.";

// A deployed preview (E2E_REMOTE=1) always has the yield pages; locally they follow the build's switch.
test.skip(process.env.E2E_REMOTE !== "1" && process.env.NEXT_PUBLIC_YIELD_PAGES_ENABLED !== "true", "the yield pages are off in this build");

test.beforeAll(() => {
  // Idempotent: the seed reports existing cycles and changes nothing on a second run. Against a deployed preview
  // (E2E_REMOTE=1) the preview's own seed runner has seeded it; nothing is written from here.
  if (process.env.E2E_REMOTE !== "1") execSync("pnpm --filter @metafarm/api seed:yield", { cwd: root, stdio: "inherit", env: process.env });
  mkdirSync(shots, { recursive: true });
});

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || /hydrat/i.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** The operator pages are read-only: no control may sign, submit, send, claim, transfer or pay anything. */
async function expectNoExecutionControls(page: Page) {
  const risky = page.getByRole("button", { name: /\b(sign|submit|send|claim|transfer|pay|execute)/i }).filter({ hasNotText: /^\s*sign out\s*$/i });
  await expect(risky).toHaveCount(0);
}

test.describe("yield operator pages (simulation)", () => {
  test("list, detail and claim intents render with the D-39 banner and without client errors", async ({ page }, info) => {
    const errors = watchErrors(page);
    await signIn(page, "owner");

    await page.goto("/yield");
    await expect(page.getByRole("heading", { level: 1, name: /Yield cycles/ })).toBeVisible();
    await expect(page.locator("[data-disclosure]")).toContainText("SIMULATION ONLY:");
    await expect(page.locator("[data-disclosure]")).toContainText(D39);
    const rows = page.locator("table tbody tr");
    await expect(rows.filter({ hasText: "2026-01-01 – 2026-03-31" })).toContainText("Published, with verification details");
    await expect(rows.filter({ hasText: "2026-04-01 – 2026-06-30" })).toContainText("Published, with verification details");
    await expect(rows.filter({ hasText: "2026-07-01 – 2026-09-30" })).toContainText("Awaiting independent review");
    await expect(rows.filter({ hasText: "2026-04-01" }).locator(".mf-pill", { hasText: "Simulation" })).toBeVisible();
    await expectNoExecutionControls(page);
    await page.screenshot({ path: path.join(shots, `${info.project.name}-1-cycle-list.png`), fullPage: true });

    // Q2: published, carry-in from Q1, four-eyes separated, dossier, and the unsigned intent batch.
    await page.getByRole("link", { name: "2026-04-01 – 2026-06-30" }).click();
    await expect(page.getByRole("heading", { level: 1, name: /2026-04-01/ })).toBeVisible();
    await expect(page.locator("[data-disclosure]")).toContainText(D39);
    await expect(page.locator("[data-section=four-eyes]")).toContainText("Separated");
    await expect(page.locator("[data-section=dossier]")).toContainText("simulation-policy");
    await expect(page.locator("[data-section=carry]").first()).toContainText(/Carry-in [\d,]+ from set/);
    const intents = page.locator("[data-section=claim-intents]");
    await expect(intents).toContainText("Unsigned");
    await expect(intents).toContainText("simulation");
    await expect(intents.locator("tbody tr")).not.toHaveCount(0);
    await expectNoExecutionControls(page);
    await page.screenshot({ path: path.join(shots, `${info.project.name}-2-cycle-published.png`), fullPage: true });

    // Q3: frozen, attested, awaiting a four-eyes approval; no intents section yet.
    await page.goto("/yield");
    await page.getByRole("link", { name: "2026-07-01 – 2026-09-30" }).click();
    await expect(page.locator("[data-disclosure]")).toContainText(D39);
    await expect(page.locator("[data-section=four-eyes]")).toContainText("Awaiting an approver");
    await expect(page.locator(".mf-pill", { hasText: "Frozen" }).first()).toBeVisible();
    await expect(page.locator("[data-section=claim-intents]")).toHaveCount(0);
    await expectNoExecutionControls(page);
    await page.screenshot({ path: path.join(shots, `${info.project.name}-3-cycle-under-review.png`), fullPage: true });

    expect(errors, errors.join("\n")).toEqual([]);
  });
});
