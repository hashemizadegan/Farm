import { describe, expect, it } from "vitest";
import { U64_MAX, YieldAmountError } from "./amounts";
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
    expect(convertAmount(5n, 0, 0, { ...rate(1n, 1n), observedAt: "2028-02-29T23:59:59.5-12:00" }).value).toBe(5n);
  });

  it("refuses rates without source or time, non-positive parts, bad exponents and negative or non-bigint amounts", () => {
    const bad = (fn: () => unknown) => expect(fn).toThrow(YieldAmountError);
    bad(() => convertAmount(1n, 2, 2, { ...rate(1n, 1n), source: "" }));
    bad(() => convertAmount(1n, 2, 2, { ...rate(1n, 1n), observedAt: "2026-09-30" }));
    bad(() => convertAmount(1n, 2, 2, { ...rate(1n, 1n), observedAt: "2026-09-30T16:00:00" }));
    // Impossible instants that Date.parse would silently roll forward.
    for (const observedAt of ["2026-02-30T16:00:00Z", "2026-04-31T16:00:00Z", "2026-09-30T24:00:00Z", "2026-09-30T16:00:00+24:00"]) bad(() => convertAmount(1n, 2, 2, { ...rate(1n, 1n), observedAt }));
    bad(() => convertAmount(1n, 2, 2, rate(0n, 1n)));
    bad(() => convertAmount(1n, 2, 2, rate(1n, 0n)));
    bad(() => convertAmount(1n, 2, 2, { ...rate(1n, 1n), num: 1 as never }));
    bad(() => convertAmount(1n, 2.5, 2, rate(1n, 1n)));
    bad(() => convertAmount(1n, -1, 2, rate(1n, 1n)));
    bad(() => convertAmount(-1n, 2, 2, rate(1n, 1n)));
    bad(() => convertAmount(1.5 as never, 2, 2, rate(1n, 1n)));
    bad(() => convertAmount(1n, 2, 2, { ...rate(1n, 1n), spread: 1n } as never));
  });
});

describe("conversion properties (seeded, 2,000 cases up to u64 and exponent 30)", () => {
  let seed = 0xfeed;
  const rand32 = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return BigInt((t ^ (t >>> 14)) >>> 0);
  };
  // Mixes small values, values near powers of two and values up to U64_MAX.
  const u64 = (): bigint => {
    const pick = Number(rand32() % 4n);
    if (pick === 0) return rand32() % 1000n;
    if (pick === 1) return (1n << (rand32() % 64n)) - (rand32() % 3n === 0n ? 1n : 0n);
    if (pick === 2) return U64_MAX - (rand32() % 1000n);
    return ((rand32() << 32n) | rand32()) & U64_MAX;
  };
  const exp = () => Number(rand32() % 31n);

  it("is exact: value × den × 10^from + dropped = amount × num × 10^to, with 0 ≤ dropped < denominator", () => {
    for (let i = 0; i < 2000; i++) {
      const amount = u64();
      const num = u64() || 1n;
      const den = u64() || 1n;
      const from = exp();
      const to = exp();
      const r = convertAmount(amount, from, to, rate(num, den));
      expect(r.denominator).toBe(den * 10n ** BigInt(from));
      expect(r.value * r.denominator + r.droppedNumerator).toBe(amount * num * 10n ** BigInt(to));
      expect(r.droppedNumerator >= 0n && r.droppedNumerator < r.denominator).toBe(true);
    }
  });

  it("is monotonic in the amount, and equivalent rates (k·num / k·den) give the same value", () => {
    for (let i = 0; i < 500; i++) {
      const amount = u64() % U64_MAX;
      const num = (u64() % 1_000_000n) + 1n;
      const den = (u64() % 1_000_000n) + 1n;
      const k = (u64() % 1000n) + 1n;
      const [from, to] = [exp(), exp()];
      const a = convertAmount(amount, from, to, rate(num, den));
      expect(convertAmount(amount + 1n, from, to, rate(num, den)).value >= a.value).toBe(true);
      const b = convertAmount(amount, from, to, rate(k * num, k * den));
      expect(b.value).toBe(a.value);
      expect(b.droppedNumerator * a.denominator).toBe(a.droppedNumerator * b.denominator);
    }
  });

  it("loses nothing scaling up at 1/1, and recovers the amount scaling back down", () => {
    for (let i = 0; i < 500; i++) {
      const amount = u64();
      const from = exp();
      const to = from + Number(rand32() % BigInt(31 - from));
      const up = convertAmount(amount, from, to, rate(1n, 1n));
      expect(up.droppedNumerator).toBe(0n);
      const down = convertAmount(up.value, to, from, rate(1n, 1n));
      expect([down.value, down.droppedNumerator]).toEqual([amount, 0n]);
    }
  });

  it("stays exact at the ceilings: U64_MAX amounts and rates, exponent 30 (results are not bounded to u64 here)", () => {
    const r = convertAmount(U64_MAX, 0, 30, rate(U64_MAX, 1n));
    expect(r.value).toBe(U64_MAX * U64_MAX * 10n ** 30n);
    expect(r.value > U64_MAX).toBe(true); // the u64 bound is applied to allocations, not to conversion
    expect(convertAmount(U64_MAX, 30, 0, rate(1n, U64_MAX))).toEqual({ value: 0n, droppedNumerator: U64_MAX, denominator: U64_MAX * 10n ** 30n });
    expect(convertAmount(0n, 30, 30, rate(U64_MAX, U64_MAX)).value).toBe(0n);
    expect(() => convertAmount(1n, 31, 0, rate(1n, 1n))).toThrow(YieldAmountError);
    expect(() => convertAmount(1n, 0, 31, rate(1n, 1n))).toThrow(YieldAmountError);
  });
});

describe("rate observation time boundaries", () => {
  const at = (observedAt: string) => () => convertAmount(1n, 2, 2, { ...rate(1n, 1n), observedAt });
  it("accepts real leap days (including 0000 and 2000), offsets up to ±23:59, and a local DST gap with an offset", () => {
    for (const t of ["2024-02-29T00:00:00Z", "2000-02-29T00:00:00Z", "0000-02-29T00:00:00Z", "2026-01-01T00:00:00+23:59", "2026-01-01T00:00:00-23:59", "2026-03-08T02:30:00-05:00", "2026-10-25T01:30:00+03:30"])
      expect(at(t), t).not.toThrow();
  });
  it("refuses impossible days, times and offsets, lowercase t/z, and missing parts", () => {
    for (const t of ["2023-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2026-06-31T00:00:00Z", "2026-12-31T23:59:60Z", "2026-01-01T00:00:00+05:60", "2026-01-01t00:00:00Z", "2026-01-01T00:00:00z", "2026-01-01T00:00Z", "2026-01-01T00:00:00+0330"])
      expect(at(t), t).toThrow(YieldAmountError);
  });
});
