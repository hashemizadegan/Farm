import { describe, expect, it } from "vitest";
import { dirOf, negotiateLocale } from "./config";
import { makeFormat } from "./format";

describe("negotiateLocale", () => {
  it("prefers the saved choice", () => {
    expect(negotiateLocale("fa", "en-US,en;q=0.9")).toBe("fa");
    expect(negotiateLocale("en", "fa-IR,fa;q=0.9")).toBe("en");
  });

  it("falls back to Accept-Language, then English", () => {
    expect(negotiateLocale(undefined, "fa-IR,fa;q=0.9,en;q=0.8")).toBe("fa");
    expect(negotiateLocale(undefined, "de-DE,en;q=0.5")).toBe("en");
    expect(negotiateLocale("xx", "de-DE")).toBe("en");
    expect(negotiateLocale(null, null)).toBe("en");
  });

  it("maps Persian to right-to-left", () => {
    expect(dirOf("fa")).toBe("rtl");
    expect(dirOf("en")).toBe("ltr");
  });
});

describe("makeFormat", () => {
  it("writes Persian numbers with Persian digits and units", () => {
    const fa = makeFormat("fa");
    expect(fa.number(1234)).toBe("۱٬۲۳۴");
    expect(fa.ha(12_345)).toBe("۱٫۲۳ هکتار");
  });

  it("keeps English output unchanged", () => {
    const en = makeFormat("en");
    expect(en.ha(12_345)).toBe("1.23 ha");
    expect(en.ha(2_500_000)).toBe("250 ha");
    expect(en.size(2048)).toBe("2 KB");
  });

  it("uses the Solar Hijri calendar for Persian dates", () => {
    // 2026-03-21 is 1 Farvardin 1405.
    expect(makeFormat("fa").date("2026-03-21T12:00:00Z")).toContain("۱۴۰۵");
  });
});
