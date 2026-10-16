import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fromLocal, toLocal } from "./local-frame";
import { QUALITY_PRESETS, autoQuality, capDevicePixelRatio, thin } from "./quality";
import { MAX_SCENE_ENTITIES, buildScene } from "./scene-builder";

const here = path.dirname(fileURLToPath(import.meta.url));
const input = JSON.parse(readFileSync(path.join(here, "__fixtures__/scene-input.json"), "utf8"));
const expected = JSON.parse(readFileSync(path.join(here, "__fixtures__/scene-expected.json"), "utf8"));

describe("buildScene (deterministic fixtures)", () => {
  it("matches the committed fixture exactly", () => {
    expect(buildScene(input)).toEqual(expected);
  });

  it("is stable across repeated builds and input ordering", () => {
    const a = buildScene(input);
    const b = buildScene({ ...input, parcels: [...input.parcels].reverse(), catalog: [...input.catalog].reverse() });
    expect(b).toEqual(a);
  });

  it("uses stable, unique entity ids", () => {
    const ids = buildScene(input).entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("north-a:r0c0");
  });

  it("keeps every entity inside the boundary and near the origin", () => {
    const s = buildScene(input);
    for (const e of s.entities) {
      expect(Math.abs(e.x)).toBeLessThan(50);
      expect(Math.abs(e.z)).toBeLessThan(50);
    }
  });

  it("labels everything illustrative and carries the disclaimer", () => {
    const s = buildScene(input);
    expect(s.entities.every((e) => e.provenance === "illustrative")).toBe(true);
    expect(s.disclaimer).toMatch(/not a survey/);
  });

  it("caps entity count", () => {
    const huge = buildScene({
      ...input,
      boundary: null,
      parcels: [{ label: "big", grid: { rows: 500, cols: 500, spacingM: 1 } }],
    });
    expect(huge.entities.length).toBe(MAX_SCENE_ENTITIES);
  });
});

describe("local frame", () => {
  it("round-trips within a millimetre", () => {
    const o = { lon: 10, lat: 45 };
    const [x, z] = toLocal(o, 10.001, 45.001);
    const back = fromLocal(o, x, z);
    expect(Math.abs(back.lon - 10.001)).toBeLessThan(1e-7);
    expect(Math.abs(back.lat - 45.001)).toBeLessThan(1e-7);
    expect(z).toBeLessThan(0); // north is -z
  });
});

describe("quality", () => {
  it("caps device pixel ratio per preset", () => {
    expect(capDevicePixelRatio(3, QUALITY_PRESETS.low)).toBe(1);
    expect(capDevicePixelRatio(3, QUALITY_PRESETS.medium)).toBe(1.5);
    expect(capDevicePixelRatio(1.25, QUALITY_PRESETS.high)).toBe(1.25);
    expect(capDevicePixelRatio(Number.NaN, QUALITY_PRESETS.high)).toBe(1);
  });

  it("picks conservative presets for constrained devices", () => {
    expect(autoQuality({ prefersReducedData: true, hardwareConcurrency: 16 })).toBe("low");
    expect(autoQuality({ hardwareConcurrency: 4 })).toBe("low");
    expect(autoQuality({ hardwareConcurrency: 8, deviceMemoryGb: 8 })).toBe("medium");
    expect(autoQuality({ hardwareConcurrency: 12, deviceMemoryGb: 16 })).toBe("high");
  });

  it("thins deterministically", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    expect(thin(items, 10)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(thin(items, 200)).toHaveLength(100);
  });
});
