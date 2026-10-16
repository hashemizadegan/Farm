import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEOMETRY_LIMITS,
  canonicalGeometryKey,
  findSelfIntersection,
  polygonAreaM2,
  squareAround,
  validateBoundary,
  type PolygonGeometry,
  type Ring,
} from "./geometry";

// A ~100 m x 100 m square near the equator (fixture, not a real farm).
const square: Ring = [
  [10.0, 0.0],
  [10.0009, 0.0],
  [10.0009, 0.0009],
  [10.0, 0.0009],
  [10.0, 0.0],
];
const poly = (...rings: Ring[]): PolygonGeometry => ({ type: "Polygon", coordinates: rings });

describe("validateBoundary", () => {
  it("accepts a simple closed polygon and computes area", () => {
    const r = validateBoundary(poly(square));
    expect(r.valid).toBe(true);
    expect(r.issues).toEqual([]);
    // 0.0009° ≈ 100.19 m at the equator → ≈ 10,038 m²
    expect(r.areaM2!).toBeGreaterThan(9_900);
    expect(r.areaM2!).toBeLessThan(10_200);
    expect(r.crs).toBe("OGC:CRS84");
  });

  it("accepts Feature and single-feature FeatureCollection wrappers", () => {
    expect(validateBoundary({ type: "Feature", properties: {}, geometry: poly(square) }).valid).toBe(true);
    expect(
      validateBoundary({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: poly(square) }] })
        .valid,
    ).toBe(true);
  });

  it("rejects multi-feature collections", () => {
    const f = { type: "Feature", properties: {}, geometry: poly(square) };
    const r = validateBoundary({ type: "FeatureCollection", features: [f, f] });
    expect(r.issues[0]!.code).toBe("INVALID_STRUCTURE");
  });

  it("rejects coordinates out of range or non-finite", () => {
    const bad: Ring = [[200, 0], [10, 0], [10, 1], [200, 0]];
    expect(validateBoundary(poly(bad)).issues[0]!.code).toBe("INVALID_COORDINATE");
    const nan = [[Number.NaN, 0], [10, 0], [10, 1], [Number.NaN, 0]];
    expect(validateBoundary({ type: "Polygon", coordinates: [nan] }).issues[0]!.code).toBe("INVALID_COORDINATE");
    const strings = [["10", "0"], [10, 0], [10, 1], ["10", "0"]];
    expect(validateBoundary({ type: "Polygon", coordinates: [strings] }).issues[0]!.code).toBe("INVALID_COORDINATE");
  });

  it("rejects unclosed rings", () => {
    const open = square.slice(0, -1);
    expect(validateBoundary(poly(open)).issues[0]!.code).toBe("RING_NOT_CLOSED");
  });

  it("rejects rings with too few positions", () => {
    expect(validateBoundary(poly([[0, 0], [1, 1], [0, 0]])).issues[0]!.code).toBe("RING_TOO_FEW_POSITIONS");
  });

  it("rejects degenerate (zero-area) rings", () => {
    const line: Ring = [[0, 0], [1, 1], [2, 2], [0, 0]];
    expect(validateBoundary(poly(line)).issues[0]!.code).toBe("RING_DEGENERATE");
  });

  it("detects a bow-tie self-intersection", () => {
    const bowtie: Ring = [[0, 0], [0.001, 0.001], [0.001, 0], [0, 0.001], [0, 0]];
    expect(findSelfIntersection(bowtie)).toBeDefined();
    expect(validateBoundary(poly(bowtie)).issues.map((i) => i.code)).toContain("SELF_INTERSECTION");
  });

  it("detects a spike (edge folding back on itself)", () => {
    const spike: Ring = [[0, 0], [0.002, 0], [0.001, 0], [0.001, 0.001], [0, 0]];
    expect(validateBoundary(poly(spike)).issues.map((i) => i.code)).toContain("SELF_INTERSECTION");
  });

  it("detects a ring that touches itself at a repeated vertex", () => {
    const pinched: Ring = [[0, 0], [0.002, 0], [0.001, 0.001], [0.002, 0.002], [0, 0.002], [0.001, 0.001], [0, 0]];
    expect(validateBoundary(poly(pinched)).issues.map((i) => i.code)).toContain("SELF_INTERSECTION");
  });

  it("enforces the vertex limit before doing quadratic work", () => {
    const many: number[][] = [];
    for (let i = 0; i < DEFAULT_GEOMETRY_LIMITS.maxVertices + 10; i++) {
      const a = (i / (DEFAULT_GEOMETRY_LIMITS.maxVertices + 10)) * Math.PI * 2;
      many.push([Math.cos(a) * 0.01, Math.sin(a) * 0.01]);
    }
    many.push(many[0]!);
    expect(validateBoundary({ type: "Polygon", coordinates: [many] }).issues[0]!.code).toBe("TOO_MANY_VERTICES");
  });

  it("rejects deeply nested payloads", () => {
    let deep: unknown = [0, 0];
    for (let i = 0; i < 20; i++) deep = [deep];
    expect(validateBoundary({ type: "Polygon", coordinates: deep }).issues[0]!.code).toBe("INPUT_TOO_DEEP");
  });

  it("rejects unsupported CRS rather than reprojecting", () => {
    const r = validateBoundary({ ...poly(square), crs: { type: "name", properties: { name: "EPSG:3857" } } });
    expect(r.issues[0]!.code).toBe("UNSUPPORTED_CRS");
    const ok = validateBoundary({ ...poly(square), crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } } });
    expect(ok.valid).toBe(true);
  });

  it("rejects non-polygon geometry types", () => {
    expect(validateBoundary({ type: "Point", coordinates: [0, 0] }).issues[0]!.code).toBe("UNSUPPORTED_GEOMETRY_TYPE");
    expect(validateBoundary({ type: "GeometryCollection", geometries: [] }).issues[0]!.code).toBe("UNSUPPORTED_GEOMETRY_TYPE");
  });

  it("validates holes", () => {
    const hole: Ring = [[10.0003, 0.0003], [10.0003, 0.0006], [10.0006, 0.0006], [10.0006, 0.0003], [10.0003, 0.0003]];
    const ok = validateBoundary(poly(square, hole));
    expect(ok.valid).toBe(true);
    expect(ok.areaM2!).toBeLessThan(validateBoundary(poly(square)).areaM2!);

    const outside: Ring = [[11, 1], [11, 1.001], [11.001, 1.001], [11.001, 1], [11, 1]];
    expect(validateBoundary(poly(square, outside)).issues.map((i) => i.code)).toContain("HOLE_OUTSIDE_SHELL");

    const crossing: Ring = [[10.0005, 0.0005], [10.0005, 0.002], [10.0006, 0.002], [10.0006, 0.0005], [10.0005, 0.0005]];
    expect(validateBoundary(poly(square, crossing)).issues.map((i) => i.code)).toContain("RINGS_INTERSECT");
  });

  it("enforces area limits", () => {
    const tiny = squareAround(10, 0, 1); // ~4 m²
    expect(validateBoundary(tiny).issues.map((i) => i.code)).toContain("AREA_TOO_SMALL");
    const huge = squareAround(10, 0, 50_000); // ~10,000 km²
    expect(validateBoundary(huge).issues.map((i) => i.code)).toContain("AREA_TOO_LARGE");
  });

  it("rejects antimeridian-spanning rings", () => {
    const ring: Ring = [[179.9, 0], [-179.9, 0], [-179.9, 0.1], [179.9, 0.1], [179.9, 0]];
    expect(validateBoundary(poly(ring)).issues[0]!.code).toBe("ANTIMERIDIAN_CROSSING");
  });

  it("produces the same canonical key regardless of orientation and start vertex", () => {
    const reversed = [...square].reverse();
    const rotated: Ring = [square[2]!, square[3]!, square[0]!, square[1]!, square[2]!];
    const a = validateBoundary(poly(square)).canonicalKey;
    expect(validateBoundary(poly(reversed)).canonicalKey).toBe(a);
    expect(validateBoundary(poly(rotated)).canonicalKey).toBe(a);
  });

  it("flags duplicates against existing keys", () => {
    const key = canonicalGeometryKey(poly(square));
    const r = validateBoundary(poly(square), DEFAULT_GEOMETRY_LIMITS, { existingCanonicalKeys: new Set([key]) });
    expect(r.issues.map((i) => i.code)).toContain("DUPLICATE_GEOMETRY");
  });

  it("normalises winding to RFC 7946 (exterior counter-clockwise)", () => {
    const cw = [...square].reverse();
    const r = validateBoundary(poly(cw));
    const ring = (r.geometry as PolygonGeometry).coordinates[0]!;
    let s = 0;
    for (let i = 0; i < ring.length - 1; i++) s += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
    expect(s).toBeGreaterThan(0);
  });

  it("computes the area of a 1 ha square within 1%", () => {
    const g = squareAround(35, 45, 50);
    const area = polygonAreaM2(g.coordinates);
    expect(Math.abs(area - 10_000) / 10_000).toBeLessThan(0.01);
  });
});
