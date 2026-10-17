import { describe, expect, it } from "vitest";
import { fromMilli, harvestAllowedFrom, movementSchema, toMilli, withinPreHarvestInterval } from "./inventory";
import { ROLE_PERMISSIONS } from "./roles";

describe("stock arithmetic", () => {
  it("sums exactly in thousandths", () => {
    const total = ["0.1", "0.2", "1250.505", "-0.805"].map(toMilli).reduce((a, b) => a + b, 0n);
    expect(fromMilli(total)).toBe("1250");
    expect(fromMilli(toMilli("12.5"))).toBe("12.5");
    expect(fromMilli(-1500n)).toBe("-1.5");
    expect(fromMilli(0n)).toBe("0");
  });
});

describe("movements", () => {
  const item = "0b3c5d7e-9f1a-4b4c-8d8e-0f1a2b3c4d5e";
  const farm = "1b3c5d7e-9f1a-4b4c-8d8e-0f1a2b3c4d5e";
  it("requires a farm for use and a reason for adjustments", () => {
    expect(movementSchema.safeParse({ kind: "use", itemId: item, quantity: "2", occurredOn: "2026-10-18" }).success).toBe(false);
    expect(movementSchema.safeParse({ kind: "use", itemId: item, quantity: "2", occurredOn: "2026-10-18", farmId: farm }).success).toBe(true);
    expect(movementSchema.safeParse({ kind: "adjust", itemId: item, quantity: "-3", occurredOn: "2026-10-18" }).success).toBe(false);
    expect(movementSchema.safeParse({ kind: "adjust", itemId: item, quantity: "-3", occurredOn: "2026-10-18", note: "spilled" }).success).toBe(true);
  });

  it("rejects zero and negative deliveries", () => {
    expect(movementSchema.safeParse({ kind: "receive", itemId: item, quantity: "0", occurredOn: "2026-10-18" }).success).toBe(false);
    expect(movementSchema.safeParse({ kind: "receive", itemId: item, quantity: "-1", occurredOn: "2026-10-18" }).success).toBe(false);
  });
});

describe("pre-harvest interval", () => {
  it("blocks harvest until the interval has passed", () => {
    expect(harvestAllowedFrom("2026-10-01", 14)).toBe("2026-10-15");
    expect(withinPreHarvestInterval("2026-10-01", 14, "2026-10-14")).toBe(true);
    expect(withinPreHarvestInterval("2026-10-01", 14, "2026-10-15")).toBe(false);
    expect(withinPreHarvestInterval("2026-10-01", 0, "2026-10-01")).toBe(false);
  });
});

describe("inventory permissions", () => {
  it("lets workers record use but not deliveries", () => {
    expect(ROLE_PERMISSIONS.worker.has("inventory:use")).toBe(true);
    expect(ROLE_PERMISSIONS.worker.has("inventory:manage")).toBe(false);
    expect(ROLE_PERMISSIONS.manager.has("inventory:manage")).toBe(true);
  });
});
