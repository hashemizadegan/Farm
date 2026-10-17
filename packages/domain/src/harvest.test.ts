import { describe, expect, it } from "vitest";
import {
  HARVEST_CODE,
  buildHarvestRecord,
  canonicalJson,
  createHarvestSchema,
  harvestChainId,
  harvestCode,
  harvestRecordHash,
  normalizeQuantity,
} from "./harvest";

const harvest = createHarvestSchema.parse({ cropName: "Pistachio", parcelLabel: "Block 3", harvestedOn: "2026-09-20", quantity: "1250.500", unit: "kg", notes: "private" });

describe("harvest public record", () => {
  const record = buildHarvestRecord({ code: "HB7K3Q9X2M", producer: "Hashemizadegan", farm: "Rafsanjan orchard", harvest, recordedAt: new Date("2026-09-21T08:15:30.789Z") });

  it("contains only public fields", () => {
    expect(record).toEqual({
      v: 1,
      batch: "HB7K3Q9X2M",
      producer: "Hashemizadegan",
      farm: "Rafsanjan orchard",
      crop: "Pistachio",
      parcel: "Block 3",
      harvestedOn: "2026-09-20",
      quantity: "1250.5",
      unit: "kg",
      grade: null,
      recordedAt: "2026-09-21T08:15:30.000Z",
    });
    expect(JSON.stringify(record)).not.toContain("private");
  });

  it("hashes the canonical form, independent of key order", async () => {
    const shuffled = Object.fromEntries(Object.entries(record).reverse());
    expect(canonicalJson(shuffled)).toBe(canonicalJson(record));
    const h = await harvestRecordHash(record);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await harvestRecordHash(shuffled)).toBe(h);
    expect(await harvestRecordHash({ ...record, quantity: "1250.6" })).not.toBe(h);
  });

  it("matches a known SHA-256", async () => {
    expect(canonicalJson({ b: [true, null, "x"], a: 1 })).toBe('{"a":1,"b":[true,null,"x"]}');
    expect(await harvestRecordHash({ b: [true, null, "x"], a: 1 })).toBe("eca8cfb31ab74533e1eb2f4c74d2d55dfe3c79ac704787e54be8647ea7777eb1");
  });
});

describe("harvest input", () => {
  it("normalises quantities", () => {
    expect(normalizeQuantity("0012.500")).toBe("12.5");
    expect(normalizeQuantity("7.000")).toBe("7");
    expect(normalizeQuantity("0.250")).toBe("0.25");
  });

  it("rejects zero, negative and imprecise quantities", () => {
    const base = { cropName: "x", harvestedOn: "2026-09-20", unit: "kg" };
    expect(createHarvestSchema.safeParse({ ...base, quantity: "0" }).success).toBe(false);
    expect(createHarvestSchema.safeParse({ ...base, quantity: "-3" }).success).toBe(false);
    expect(createHarvestSchema.safeParse({ ...base, quantity: "1.2345" }).success).toBe(false);
    expect(createHarvestSchema.safeParse({ ...base, quantity: "3.5" }).success).toBe(true);
  });
});

describe("codes and chain ids", () => {
  it("makes readable, unambiguous label codes", () => {
    for (let i = 0; i < 50; i++) expect(harvestCode()).toMatch(HARVEST_CODE);
    expect(harvestCode(() => new Uint8Array(16))).toBe("2222222222");
  });

  it("encodes a UUID as bytes32", () => {
    expect(harvestChainId("0b3c5d7e-9f1a-2b4c-6d8e-0f1a2b3c4d5e")).toBe(`0x${"0".repeat(32)}0b3c5d7e9f1a2b4c6d8e0f1a2b3c4d5e`);
    expect(() => harvestChainId("nope")).toThrow();
  });
});
