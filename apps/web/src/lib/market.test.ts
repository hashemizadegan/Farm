import { describe, expect, it } from "vitest";
import { formatMoney, marketplaceBuildProblem, marketplaceEnabled, orderTone, parseMoney, parseQuantity, stepIndex } from "./market";

describe("marketplace display helpers", () => {
  it("is on only with the exact flag, and refused in production builds", () => {
    expect(marketplaceEnabled({ NEXT_PUBLIC_MARKETPLACE_ENABLED: "true" })).toBe(true);
    expect(marketplaceEnabled({ NEXT_PUBLIC_MARKETPLACE_ENABLED: "1" })).toBe(false);
    expect(marketplaceBuildProblem({ NEXT_PUBLIC_MARKETPLACE_ENABLED: "true", APP_ENV: "production" })).toMatch(/simulation-only/);
    expect(marketplaceBuildProblem({ NEXT_PUBLIC_MARKETPLACE_ENABLED: "true", APP_ENV: "development" })).toBeNull();
  });

  it("formats minor units per currency and locale", () => {
    const plain = (x: string) => x.replace(/\s/g, " ");
    expect(plain(formatMoney("en-GB", 4_500_000, "IRR"))).toBe("IRR 4,500,000");
    expect(plain(formatMoney("en-GB", 12_550, "USD"))).toBe("USD 125.50");
    expect(formatMoney("fa-IR", 4_500_000, "IRR")).toContain("۴٬۵۰۰٬۰۰۰");
  });

  it("parses amounts and quantities typed in Latin or Persian digits", () => {
    expect(parseMoney("4,500,000", "IRR")).toBe(4_500_000);
    expect(parseMoney("۴۵۰۰۰۰۰", "IRR")).toBe(4_500_000);
    expect(parseMoney("125.5", "USD")).toBe(12_550);
    expect(parseMoney("1.5", "IRR")).toBeNull();
    expect(parseMoney("0", "USD")).toBeNull();
    expect(parseMoney("abc", "USD")).toBeNull();
    expect(parseQuantity("2.5")).toBe(2.5);
    expect(parseQuantity("۲٫۵")).toBe(2.5);
    expect(parseQuantity("1.2345")).toBeNull();
    expect(parseQuantity("-1")).toBeNull();
  });

  it("places an order on its progress line", () => {
    expect(stepIndex("produce", "dispatched")).toBe(3);
    expect(stepIndex("produce", "cancelled")).toBe(-1);
    expect(orderTone("delivered")).toBe("ok");
    expect(orderTone("refunded")).toBe("neutral");
  });
});
