import { describe, expect, it } from "vitest";
import { EXPORT_COLUMNS, EXPORT_DATASETS, csvField, exportFilename, exportQuerySchema, plainNumber, toCsv } from "./exports";

describe("csv", () => {
  it("quotes only when needed", () => {
    expect(csvField("Urea")).toBe("Urea");
    expect(csvField('Row "4", north')).toBe('"Row ""4"", north"');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(" padded")).toBe('" padded"');
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("keeps numbers, including negatives, but defuses formulas", () => {
    expect(csvField("-2.5")).toBe("-2.5");
    expect(csvField(-3)).toBe("-3");
    expect(csvField("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvField("+1 call me")).toBe("'+1 call me");
    expect(csvField("@sum")).toBe("'@sum");
    expect(csvField("-rf")).toBe("'-rf");
  });

  it("writes a BOM, a header and CRLF rows", () => {
    expect(toCsv(["a", "b"], [["1", null], ["کود", "x,y"]])).toBe('﻿a,b\r\n1,\r\nکود,"x,y"\r\n');
  });

  it("has the same columns in every language", () => {
    for (const d of EXPORT_DATASETS) expect(EXPORT_COLUMNS.fa[d]).toHaveLength(EXPORT_COLUMNS.en[d].length);
  });

  it("names files by dataset and range", () => {
    expect(exportFilename("harvests", { from: "2026-01-01" }, "2026-10-18")).toBe("harvests_2026-01-01_2026-10-18.csv");
    expect(exportFilename("stock", {}, "2026-10-18")).toBe("stock_start_2026-10-18.csv");
  });

  it("validates the range", () => {
    expect(exportQuerySchema.safeParse({ from: "2026-10-02", to: "2026-10-01" }).success).toBe(false);
    expect(exportQuerySchema.parse({}).lang).toBe("en");
  });

  it("tidies numerics", () => {
    expect(plainNumber("-2.500", true)).toBe("2.5");
    expect(plainNumber("10.000")).toBe("10");
    expect(plainNumber(null)).toBe("");
  });
});
