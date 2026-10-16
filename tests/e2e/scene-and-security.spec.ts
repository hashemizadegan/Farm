import { expect, test, type APIRequestContext } from "@playwright/test";
import { API, randomCoords, signIn, tokens, unique } from "./helpers";

async function createFarmWithPlan(request: APIRequestContext) {
  const auth = { authorization: `Bearer ${tokens().owner}` };
  const me = await (await request.get(`${API}/v1/me`, { headers: auth })).json();
  const tenantId = me.tenants.find((t: { slug: string }) => t.slug === "demo").tenantId;
  const { lat, lon } = randomCoords();
  const farm = await (
    await request.post(`${API}/v1/tenants/${tenantId}/farms`, { headers: auth, data: { name: unique("Scene farm"), origin: { lat: Number(lat), lon: Number(lon) } } })
  ).json();
  await request.put(`${API}/v1/tenants/${tenantId}/farms/${farm.id}/plan`, {
    headers: auth,
    data: { name: "Plan", parcels: [{ label: "Parcel 1", cropName: "Example", grid: { rows: 3, cols: 4, spacingM: 2 } }] },
  });
  return { tenantId, farmId: farm.id as string };
}

test.describe("3D scene", () => {
  test("offers a keyboard-operable list equivalent with stable entity ids", async ({ page, request }) => {
    const { farmId } = await createFarmWithPlan(request);
    await signIn(page);
    await page.goto(`/farms/${farmId}/scene?view=list`);
    await expect(page.getByText("Illustrative only.")).toBeVisible();
    const row = page.locator('[data-entity-id="parcel-1:r0c0"]');
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /Select/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Selected element" })).toBeVisible();
    await expect(page.getByTestId("scene-status")).toContainText("Selected");
  });

  test("falls back to the list when WebGL is unavailable", async ({ page, request }) => {
    const { farmId } = await createFarmWithPlan(request);
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      // Simulate a device without WebGL.
      HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
        if (type.includes("webgl")) return null;
        return (orig as (...a: unknown[]) => unknown).call(this, type, ...args);
      } as typeof orig;
    });
    await signIn(page);
    await page.goto(`/farms/${farmId}/scene`);
    await expect(page.getByTestId("webgl-fallback")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Scene elements/ })).toBeVisible();
  });
});

test.describe("tenant isolation and headers", () => {
  test("another tenant cannot read this tenant's farm", async ({ request }) => {
    const { tenantId, farmId } = await createFarmWithPlan(request);
    const res = await request.get(`${API}/v1/tenants/${tenantId}/farms/${farmId}`, { headers: { authorization: `Bearer ${tokens().other}` } });
    expect(res.status()).toBe(404);
  });

  test("web responses carry a nonce-based CSP", async ({ request }) => {
    const res = await request.get("/sign-in");
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src[^;]*'nonce-/);
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
