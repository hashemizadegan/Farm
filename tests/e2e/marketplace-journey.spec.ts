import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { API, signIn, tokens } from "./helpers";

/**
 * Marketplace journey between two users in two workspaces (simulation only), over the seeded demo
 * (apps/api/src/scripts/seed-marketplace.ts): `dev-user` (owner of Demo Tenant) sells, `dev-other` (owner of Other
 * Tenant) buys. Each user has their own browser context, as two people would.
 *
 * - produce: the buyer orders pistachios for courier delivery (quantity, address, cost estimate), records the simulated
 *   payment; the seller prepares and dispatches with a manual courier reference; the buyer sees the tracking reference
 *   and confirms receipt; both see the same history;
 * - registered asset: an offer on the drip irrigation kit; the controller accepts, the buyer pays (simulated), the
 *   controller records the transfer of control; the new controller sees it as eligible to list, the old one does not;
 * - Persian: the catalogue, a listing and an order in Persian, right to left, with Persian digits.
 *
 * Runs unchanged against the isolated preview (E2E_REMOTE=1; each run uses a little pistachio stock and moves the kit
 * between the two workspaces) and the local stack. With E2E_SCREENSHOTS=1 it also saves review screenshots.
 */
const PISTACHIOS = "Fresh pistachios, Akbari, Grade A (simulation)";
const KIT_ASSET = "Drip irrigation kit, block 2 (simulation)";
const REMOTE = process.env.E2E_REMOTE === "1";
const WEB = process.env.E2E_WEB_URL ?? "http://localhost:3000";
const GATE_PASSWORD = process.env.E2E_PREVIEW_ACCESS_PASSWORD;
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
const OUT = path.resolve(import.meta.dirname, "../review-shots");

test.skip(({ isMobile }) => isMobile, "the two-party journey runs once, on desktop (the Persian check covers layout)");
test.describe.configure({ mode: "serial" });

const bearer = (who: "owner" | "other") => ({ authorization: `Bearer ${tokens()[who]}` });

async function tenantOf(request: APIRequestContext, who: "owner" | "other"): Promise<string> {
  return (await (await request.get(`${API}/v1/me`, { headers: bearer(who) })).json()).tenants[0].tenantId;
}

/** A second person: their own browser context (with the preview gate's credentials when remote). */
async function personPage(browser: Browser, who: "owner" | "other", locale?: "fa"): Promise<Page> {
  const context = await browser.newContext({
    baseURL: WEB,
    viewport: { width: 1366, height: 900 },
    ...(REMOTE && GATE_PASSWORD ? { httpCredentials: { username: "preview", password: GATE_PASSWORD, origin: new URL(WEB).origin, send: "always" as const } } : {}),
  });
  const page = await context.newPage();
  await signIn(page, who);
  // The sign-in form is driven in English; the language is the reader's saved choice from then on.
  if (locale) await context.addCookies([{ name: "mf_locale", value: locale, url: WEB }]);
  return page;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => window.scrollTo(0, 0));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, `${name}.jpg`), await page.screenshot({ type: "jpeg", quality: 80, fullPage: true }));
  console.log(`SHOT ${name} ${page.url()} commit=${(process.env.RAILWAY_GIT_COMMIT_SHA ?? "local").slice(0, 7)} at=${new Date().toISOString()}`);
}

async function clean(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations).toEqual([]);
}

test("produce: order, simulated payment, preparation, manual dispatch with tracking, confirmed delivery", async ({ browser }) => {
  test.setTimeout(180_000);
  const seller = await personPage(browser, "owner");
  const buyer = await personPage(browser, "other");

  // The seller sees the catalogue with the simulation notice and their own listings.
  await seller.goto("/market");
  await expect(seller.getByRole("heading", { level: 1, name: "Marketplace" })).toBeVisible();
  await expect(seller.locator("[data-simulation-notice]")).toContainText("SIMULATION ONLY");
  await expect(seller.getByRole("article", { name: PISTACHIOS })).toContainText("Your listing");
  await clean(seller);
  await shot(seller, "m1-catalogue-en");

  // The buyer opens the listing: provenance (the harvest batch's traceable record) and current checks.
  await buyer.goto("/market");
  await buyer.getByRole("link", { name: PISTACHIOS }).click();
  await expect(buyer.getByRole("heading", { name: PISTACHIOS })).toBeVisible();
  const provenance = buyer.getByRole("region", { name: "Provenance and ownership checks" });
  await expect(provenance).toContainText("Batch code");
  await expect(provenance).toContainText("Harvest batch recorded (traceable record)");
  await expect(provenance).toContainText("Batch not voided");

  // Order 2.5 kg by courier: the estimate follows the method and quantity.
  const form = buyer.getByRole("form", { name: "Order" });
  await form.getByLabel("Quantity (kg)").fill("2.5");
  await form.getByLabel(/Courier, arranged by the seller/).check();
  await form.getByLabel("Recipient").fill("Other Tenant User (simulation)");
  await form.getByLabel("Address", { exact: true }).fill("1 Example Street (simulation)");
  await form.getByLabel("City").fill("Isfahan");
  await form.getByLabel("Postal code").fill("81000");
  await form.getByLabel("Phone").fill("+98 31 0000 0000");
  await expect(form.getByText("Total (simulated)")).toBeVisible();
  // 2.5 × 4,500,000 + (2,500,000 + 2.5 × 50,000) = 11,250,000 + 2,625,000.
  await expect(form).toContainText("13,875,000");
  await shot(buyer, "m2-listing-order-form-en");
  await form.getByRole("button", { name: "Place order (simulated)" }).click();

  await buyer.waitForURL(/\/market\/orders\/[0-9a-f-]{36}$/);
  const orderUrl = new URL(buyer.url()).pathname;
  await expect(buyer.getByText("Awaiting payment (simulated)").first()).toBeVisible();
  await buyer.getByRole("button", { name: "Record payment (simulated)" }).click();
  await expect(buyer.getByText("Paid (simulated)").first()).toBeVisible();

  // The seller finds it under "Selling", prepares and dispatches it with the courier's reference.
  await seller.goto("/market/orders?side=seller");
  await seller.getByRole("link", { name: PISTACHIOS }).first().click();
  await expect(seller).toHaveURL(new RegExp(`${orderUrl}$`));
  await expect(seller.getByText("Your workspace is the seller")).toBeVisible();
  await expect(seller.getByRole("region", { name: "Delivery" })).toContainText("Isfahan");
  await seller.getByRole("button", { name: "Start preparing" }).click();
  const dispatch = seller.getByRole("form", { name: "Mark dispatched" });
  const tracking = `SIM-${Date.now().toString(36).toUpperCase()}`;
  await dispatch.getByLabel("Carrier or courier").fill("Manual courier (simulation)");
  await dispatch.getByLabel("Tracking reference").fill(tracking);
  await dispatch.getByRole("button", { name: "Mark dispatched" }).click();
  await expect(seller.getByText("Dispatched").first()).toBeVisible();
  await expect(seller.getByRole("region", { name: "Delivery" })).toContainText(tracking);
  await shot(seller, "m3-order-dispatched-seller-en");

  // The buyer sees the tracking reference and confirms receipt: the order is complete for both.
  await buyer.reload();
  await expect(buyer.getByRole("region", { name: "Delivery" })).toContainText(tracking);
  await expect(buyer.getByRole("region", { name: "Delivery" })).toContainText("No carrier is integrated");
  await buyer.getByRole("button", { name: "Confirm receipt" }).click();
  await expect(buyer.getByText("Delivered").first()).toBeVisible();
  const history = buyer.getByRole("region", { name: "History" });
  for (const step of ["Order placed", "Payment recorded (simulated)", "Preparation started", "Dispatched", "Receipt confirmed"]) await expect(history).toContainText(step);
  await expect(buyer.getByRole("region", { name: "What you can do now" })).toContainText("Nothing for your workspace to do now.");
  await clean(buyer);
  await shot(buyer, "m4-order-delivered-buyer-en");

  await seller.reload();
  await expect(seller.getByText("Delivered").first()).toBeVisible();
  await seller.context().close();
  await buyer.context().close();
});

test("registered asset: offer, acceptance, simulated payment, recorded transfer of control; only the controller can list it", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const tenants = { owner: await tenantOf(request, "owner"), other: await tenantOf(request, "other") };
  // Whichever workspace controls the kit now sells it (each run moves it): find its open listing, or list it.
  const catalogue = (await (await request.get(`${API}/v1/tenants/${tenants.owner}/market/listings?kind=registered_asset`, { headers: bearer("owner") })).json()).items as {
    id: string;
    status: string;
    title: string;
    pricing: string;
    seller: { tenantId: string };
    provenance: { assetName?: string };
  }[];
  let listing = catalogue.find((l) => l.provenance.assetName === KIT_ASSET && l.status === "active" && l.pricing === "offers");
  if (!listing) {
    for (const who of ["owner", "other"] as const) {
      const items = (await (await request.get(`${API}/v1/tenants/${tenants[who]}/market/eligible-items`, { headers: bearer(who) })).json()).assets as { id: string; name: string; eligible: boolean }[];
      const kit = items.find((a) => a.name === KIT_ASSET && a.eligible);
      if (!kit) continue;
      const r = await request.post(`${API}/v1/tenants/${tenants[who]}/market/listings`, {
        headers: bearer(who),
        data: { kind: "registered_asset", assetId: kit.id, pricing: "offers", priceMinor: 180_000_000, currency: "IRR", title: "Drip irrigation kit, block 2 (simulation)" },
      });
      expect(r.status()).toBe(201);
      listing = await r.json();
      break;
    }
  }
  expect(listing, "an open offers listing for the kit").toBeTruthy();
  const sellerWho = listing!.seller.tenantId === tenants.owner ? "owner" : "other";
  const buyerWho = sellerWho === "owner" ? "other" : "owner";
  const seller = await personPage(browser, sellerWho);
  const buyer = await personPage(browser, buyerWho);

  await buyer.goto(`/market/${listing!.id}`);
  const provenance = buyer.getByRole("region", { name: "Provenance and ownership checks" });
  await expect(provenance).toContainText("Verified by a second person (four eyes)");
  await expect(provenance).toContainText("Controlled by the seller's workspace");
  await expect(provenance).toContainText("No mainnet token");
  const offer = buyer.getByRole("form", { name: "Make an offer" });
  await offer.getByLabel("Your offer (IRR)").fill("150,000,000");
  await offer.getByRole("button", { name: "Send offer (simulated)" }).click();
  await buyer.waitForURL(/\/market\/orders\/[0-9a-f-]{36}$/);
  const orderUrl = new URL(buyer.url()).pathname;
  await expect(buyer.getByText("Offer awaiting the seller").first()).toBeVisible();

  await seller.goto(orderUrl);
  await seller.getByRole("button", { name: "Accept offer" }).click();
  await expect(seller.getByText("Awaiting payment (simulated)").first()).toBeVisible();
  await buyer.reload();
  await buyer.getByRole("button", { name: "Record payment (simulated)" }).click();
  await expect(buyer.getByText("Paid (simulated)").first()).toBeVisible();
  await seller.reload();
  seller.once("dialog", (d) => void d.accept());
  await seller.getByRole("button", { name: "Record transfer of control (simulated)" }).click();
  await expect(seller.getByText("Control transferred (simulated)").first()).toBeVisible();
  await expect(seller.getByRole("region", { name: "History" })).toContainText("Now controlled by");
  await shot(seller, "m5-asset-transferred-en");

  // The new controller can list it; the previous one sees why it cannot.
  await buyer.goto("/market/sell");
  const mine = buyer.getByRole("article", { name: KIT_ASSET });
  await expect(mine).toContainText("Eligible");
  await expect(mine).toContainText("Acquired on this marketplace (simulated)");
  await seller.goto("/market/sell");
  await expect(seller.getByRole("heading", { level: 2, name: "Registered assets" })).toBeVisible();
  // The workspace that registered it still sees it, and why it cannot list it; any other former controller does not.
  if (sellerWho === "owner") await expect(seller.getByRole("article", { name: KIT_ASSET })).toContainText("This workspace does not control it");
  else await expect(seller.getByRole("article", { name: KIT_ASSET })).toHaveCount(0);
  await clean(seller);
  await shot(seller, "m6-sell-eligibility-en");
  // Leave the kit listed by its new controller for the next run.
  await buyer.getByRole("article", { name: KIT_ASSET }).getByRole("button", { name: "List this" }).click();
  const listForm = buyer.getByRole("form", { name: `List this: ${KIT_ASSET}` });
  await listForm.getByLabel("How it is sold").selectOption("offers");
  await listForm.getByLabel("Price (IRR)").fill("180000000");
  await listForm.getByRole("button", { name: "List (simulated)" }).click();
  await buyer.waitForURL(/\/market\/[0-9a-f-]{36}$/);
  await expect(buyer.getByText("This is your workspace's listing.")).toBeVisible();
  await seller.context().close();
  await buyer.context().close();
});

test("Persian: the marketplace in Persian, right to left, with Persian digits", async ({ browser }) => {
  const page = await personPage(browser, "other", "fa");
  await page.goto("/market");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "بازارچه" })).toBeVisible();
  await expect(page.locator("[data-simulation-notice]")).toContainText("فقط شبیه‌سازی");
  await expect(page.getByRole("article", { name: PISTACHIOS })).toContainText("ریال");
  await expect(page.getByRole("article", { name: PISTACHIOS })).toContainText(/[۰-۹]/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await clean(page);
  await shot(page, "m7-catalogue-fa");
  await page.getByRole("link", { name: PISTACHIOS }).click();
  await expect(page.getByRole("region", { name: "منشأ و بررسی مالکیت" })).toContainText("کد بهره");
  await shot(page, "m8-listing-fa");
  await page.goto("/market/orders");
  await expect(page.getByRole("heading", { level: 1, name: "سفارش‌های شما" })).toBeVisible();
  await page.getByRole("table").getByRole("link").first().click();
  await expect(page.getByRole("region", { name: "سابقه" })).toBeVisible();
  await clean(page);
  await shot(page, "m9-order-fa");
  await page.context().close();
});
