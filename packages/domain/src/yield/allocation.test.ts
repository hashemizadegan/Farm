import { describe, expect, it } from "vitest";
import { U64_MAX, type YieldAmountError } from "./amounts";
import { compareRecipientBytes, splitProportionally } from "./allocation";

const largest = { remainder: "largest_remainder", dustThreshold: 0n } as const;
const carry = { remainder: "carry", dustThreshold: 0n } as const;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as YieldAmountError).code;
  }
  return "no error";
};

describe("proportional split", () => {
  it("F: 1,000,000 base units among three equal holders → 333,334 / 333,333 / 333,333 (plan example F)", () => {
    const r = splitProportionally(1_000_000n, [{ recipient: "03", weight: 1n }, { recipient: "01", weight: 1n }, { recipient: "02", weight: 1n }], largest);
    expect(r.allocations.map((a) => [a.recipient, a.amount])).toEqual([
      ["01", 333_334n],
      ["02", 333_333n],
      ["03", 333_333n],
    ]);
    expect(r.remainder).toBe(0n);
  });

  it("F with the carry rule: nothing extra allocated; the remainder is returned", () => {
    const r = splitProportionally(1_000_000n, [{ recipient: "01", weight: 1n }, { recipient: "02", weight: 1n }, { recipient: "03", weight: 1n }], carry);
    expect(r.allocations.map((a) => a.amount)).toEqual([333_333n, 333_333n, 333_333n]);
    expect(r.remainder).toBe(1n);
  });

  it("gives remainder units to the largest fractions first, ties by ascending bytes", () => {
    // 10 split 1:1:1:2 over weight 5 → 2, 2, 2, 4 exactly; 11 → floors 2,2,2,4 rem 1; fractions 1/5,1/5,1/5,2/5 → "04" first.
    const r = splitProportionally(11n, [{ recipient: "01", weight: 1n }, { recipient: "02", weight: 1n }, { recipient: "03", weight: 1n }, { recipient: "04", weight: 2n }], largest);
    expect(r.allocations.map((a) => a.amount)).toEqual([2n, 2n, 2n, 5n]);
    expect(splitProportionally(10n, [{ recipient: "01", weight: 1n }, { recipient: "02", weight: 1n }, { recipient: "03", weight: 1n }, { recipient: "04", weight: 2n }], largest).allocations.map((a) => a.amount)).toEqual([2n, 2n, 2n, 4n]);
  });

  it("always conserves the total: Σ allocations + remainder = total", () => {
    for (const total of [0n, 1n, 7n, 999_999_937n, U64_MAX])
      for (const rule of [largest, carry]) {
        const r = splitProportionally(total, [{ recipient: "aa", weight: 3n }, { recipient: "bb", weight: 5n }, { recipient: "cc", weight: 11n }], rule);
        expect(r.allocations.reduce((s, a) => s + a.amount, 0n) + r.remainder).toBe(total);
      }
  });

  it("marks dust as deferred but keeps it allocated to its recipient", () => {
    const r = splitProportionally(100n, [{ recipient: "01", weight: 1n }, { recipient: "02", weight: 99n }], { remainder: "largest_remainder", dustThreshold: 5n });
    expect(r.allocations).toEqual([
      { recipient: "01", amount: 1n, deferred: true },
      { recipient: "02", amount: 99n, deferred: false },
    ]);
    expect(r.remainder).toBe(0n);
  });

  it("G: fails deterministically when an allocation does not fit u64", () => {
    expect(splitProportionally(U64_MAX, [{ recipient: "01", weight: 1n }], largest).allocations[0]!.amount).toBe(U64_MAX);
    expect(code(() => splitProportionally(U64_MAX + 1n, [{ recipient: "01", weight: 1n }], largest))).toBe("amount_out_of_range");
    expect(code(() => splitProportionally(2n ** 70n, [{ recipient: "01", weight: 1n }, { recipient: "02", weight: 1n }], carry))).toBe("amount_out_of_range");
  });

  it("orders output by recipient bytes whatever the input order, and is repeatable", () => {
    const w = [{ recipient: "ff", weight: 2n }, { recipient: "00ff", weight: 3n }, { recipient: "0a", weight: 5n }];
    const a = splitProportionally(1000n, w, largest);
    const b = splitProportionally(1000n, [...w].reverse(), largest);
    expect(a).toEqual(b);
    expect(a.allocations.map((x) => x.recipient)).toEqual(["00ff", "0a", "ff"]);
    expect(compareRecipientBytes("00", "0000") < 0).toBe(true);
  });

  it("refuses missing rules, bad recipients, duplicates, zero total weight and non-bigint values", () => {
    const w = [{ recipient: "01", weight: 1n }];
    expect(code(() => splitProportionally(1n, w, {} as never))).toBe("invalid_parameter");
    expect(code(() => splitProportionally(1n, w, { remainder: "largest_remainder" } as never))).toBe("not_integer");
    expect(code(() => splitProportionally(1n, [{ recipient: "0G", weight: 1n }], largest))).toBe("invalid_parameter");
    expect(code(() => splitProportionally(1n, [{ recipient: "AB", weight: 1n }], largest))).toBe("invalid_parameter");
    expect(code(() => splitProportionally(1n, [{ recipient: "01", weight: 1n }, { recipient: "01", weight: 2n }], largest))).toBe("invalid_parameter");
    expect(code(() => splitProportionally(1n, [{ recipient: "01", weight: 0n }], largest))).toBe("invalid_parameter");
    expect(code(() => splitProportionally(1n, [], largest))).toBe("invalid_parameter");
    expect(code(() => splitProportionally(1 as never, w, largest))).toBe("not_integer");
    expect(code(() => splitProportionally(1n, [{ recipient: "01", weight: -1n }], largest))).toBe("negative");
    // Unsupported keys are refused, not ignored.
    expect(code(() => splitProportionally(1n, w, { ...largest, minimumPayout: 5n } as never))).toBe("invalid_parameter");
    expect(code(() => splitProportionally(1n, [{ recipient: "01", weight: 1n, wallet: "x" }] as never, largest))).toBe("invalid_parameter");
  });
});
