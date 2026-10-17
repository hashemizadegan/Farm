import { describe, expect, it } from "vitest";
import { outlinePath } from "./outline";

const nums = (d: string) => [...d.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));

describe("outlinePath", () => {
  it("fits a ring inside the padded 100×100 box with north up", () => {
    const d = outlinePath([
      [10, 0],
      [10.001, 0],
      [10.001, 0.002],
      [10, 0.002],
      [10, 0],
    ]);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    const v = nums(d);
    expect(Math.min(...v)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...v)).toBeLessThanOrEqual(90);
    // First point is the south-west corner: bottom of the box (larger y).
    expect(v[1]).toBeCloseTo(90, 1);
  });

  it("keeps true proportions at high latitude (longitude scaled by cos(lat))", () => {
    // 0.002° of longitude at 60°N is about as wide as 0.001° of latitude is tall.
    const d = outlinePath([
      [0, 60],
      [0.002, 60],
      [0.002, 60.001],
      [0, 60.001],
      [0, 60],
    ]);
    const v = nums(d);
    const xs = v.filter((_, i) => i % 2 === 0);
    const ys = v.filter((_, i) => i % 2 === 1);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    expect(w / h).toBeCloseTo(1, 1);
  });
});
