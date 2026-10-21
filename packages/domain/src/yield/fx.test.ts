import { describe, expect, it } from "vitest";
import { YieldAmountError } from "./amounts";
import { convertAmount } from "./fx";

const rate = (num: bigint, den: bigint) => ({ num, den, source: "simulation-rate", observedAt: "2026-09-30T16:00:00Z" });

describe("conversion", () => {
  it("E: 10,000.00 EUR at 217/200 → 10,850.00 USD (1,085,000 minor units), nothing dropped", () => {
    // The fraction is reported unreduced over den × 10^fromExponent.
    expect(convertAmount(1_000_000n, 2, 2, rate(217n, 200n))).toEqual({ value: 1_085_000n, droppedNumerator: 0n, denominator: 20_000n });
  });

  it("rounds down and returns the dropped fraction exactly", () => {
    const r = convertAmount(1n, 2, 2, rate(1n, 3n));
    expect(r).toEqual({ value: 0n, droppedNumerator: 100n, denominator: 300n }); // exactly 1/3, unreduced
    const s = convertAmount(10n, 2, 0, rate(1n, 1n)); // 0.10 in a currency with no minor unit
    expect(s).toEqual({ value: 0n, droppedNumerator: 10n, denominator: 100n });
  });

  it("scales between exponents (minor units to token base units)", () => {
    expect(convertAmount(382_500n, 2, 6, rate(1n, 1n)).value).toBe(3_825_000_000n);
    expect(convertAmount(5n, 0, 3, rate(1n, 1n)).value).toBe(5_000n);
  });

  it("refuses rates without source or time, non-positive parts, bad exponents and negative or non-bigint amounts", () => {
    const bad = (fn: () => unknown) => expect(fn).toThrow(YieldAmountError);
    bad(() => convertAmount(1n, 2, 2, { ...rate(1n, 1n), source: "" }));
    bad(() => convertAmount(1n, 2, 2, { ...rate(1n, 1n), observedAt: "2026-09-30" }));
    bad(() => convertAmount(1n, 2, 2, { ...rate(1n, 1n), observedAt: "2026-09-30T16:00:00" }));
    bad(() => convertAmount(1n, 2, 2, rate(0n, 1n)));
    bad(() => convertAmount(1n, 2, 2, rate(1n, 0n)));
    bad(() => convertAmount(1n, 2, 2, { ...rate(1n, 1n), num: 1 as never }));
    bad(() => convertAmount(1n, 2.5, 2, rate(1n, 1n)));
    bad(() => convertAmount(1n, -1, 2, rate(1n, 1n)));
    bad(() => convertAmount(-1n, 2, 2, rate(1n, 1n)));
    bad(() => convertAmount(1.5 as never, 2, 2, rate(1n, 1n)));
  });
});
