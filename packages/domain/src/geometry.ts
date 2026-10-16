/**
 * Boundary geometry validation.
 *
 * Runs in the API before anything touches the database, so malformed or
 * hostile GeoJSON is rejected cheaply. PostGIS repeats the authoritative
 * validity check (ST_IsValidDetail) inside the GIS validation job.
 *
 * Coordinates are WGS 84 longitude/latitude (RFC 7946, OGC:CRS84). We do not
 * reproject: any other declared CRS is rejected rather than guessed.
 */

export type Position = [number, number] | [number, number, number];
export type Ring = Position[];

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Ring[];
}
export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: Ring[][];
}
export type BoundaryGeometry = PolygonGeometry | MultiPolygonGeometry;

export const ACCEPTED_CRS = ["OGC:CRS84", "urn:ogc:def:crs:OGC:1.3:CRS84", "EPSG:4326", "urn:ogc:def:crs:EPSG::4326"];
export const STORAGE_SRID = 4326;

export interface GeometryLimits {
  maxVertices: number;
  maxRingsPerPolygon: number;
  maxPolygons: number;
  minAreaM2: number;
  maxAreaM2: number;
  /** Max nesting depth of the raw JSON input; guards against pathological payloads. */
  maxDepth: number;
}

export const DEFAULT_GEOMETRY_LIMITS: GeometryLimits = {
  maxVertices: 2_000,
  maxRingsPerPolygon: 50,
  maxPolygons: 20,
  minAreaM2: 10,
  // 1,000 km² — large enough for most single farm projects; tenants can be configured lower.
  maxAreaM2: 1_000_000_000,
  maxDepth: 8,
};

export type GeometryIssueCode =
  | "INVALID_STRUCTURE"
  | "UNSUPPORTED_GEOMETRY_TYPE"
  | "UNSUPPORTED_CRS"
  | "INPUT_TOO_DEEP"
  | "INVALID_COORDINATE"
  | "RING_NOT_CLOSED"
  | "RING_TOO_FEW_POSITIONS"
  | "RING_DEGENERATE"
  | "TOO_MANY_VERTICES"
  | "TOO_MANY_RINGS"
  | "TOO_MANY_POLYGONS"
  | "SELF_INTERSECTION"
  | "RINGS_INTERSECT"
  | "HOLE_OUTSIDE_SHELL"
  | "ANTIMERIDIAN_CROSSING"
  | "AREA_TOO_SMALL"
  | "AREA_TOO_LARGE"
  | "DUPLICATE_GEOMETRY";

export interface GeometryIssue {
  code: GeometryIssueCode;
  message: string;
  /** Path into the coordinates array, e.g. [polygon, ring, vertex]. */
  path?: number[];
}

export interface GeometryValidationResult {
  valid: boolean;
  issues: GeometryIssue[];
  geometry?: BoundaryGeometry;
  vertexCount: number;
  areaM2?: number;
  /** Canonical, orientation- and start-independent key used for duplicate detection. */
  canonicalKey?: string;
  crs: "OGC:CRS84";
}

const EARTH_RADIUS_M = 6_371_008.8;

function depthOf(value: unknown, limit: number, depth = 0): number {
  if (depth > limit) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const v of value) {
      max = Math.max(max, depthOf(v, limit, depth + 1));
      if (max > limit) return max;
    }
    return max;
  }
  return depth;
}

/** Extracts a Polygon/MultiPolygon from a geometry, Feature or single-feature FeatureCollection. */
export function extractGeometry(input: unknown): { geometry?: unknown; crs?: unknown; error?: GeometryIssue } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: { code: "INVALID_STRUCTURE", message: "expected a GeoJSON object" } };
  }
  const obj = input as Record<string, unknown>;
  const crs = obj.crs;
  if (obj.type === "FeatureCollection") {
    const features = obj.features;
    if (!Array.isArray(features) || features.length !== 1) {
      return {
        error: { code: "INVALID_STRUCTURE", message: "a FeatureCollection must contain exactly one feature" },
      };
    }
    const inner = extractGeometry(features[0]);
    return { ...inner, crs: inner.crs ?? crs };
  }
  if (obj.type === "Feature") {
    return { geometry: obj.geometry, crs };
  }
  return { geometry: obj, crs };
}

function crsName(crs: unknown): string | undefined {
  if (crs === undefined || crs === null) return undefined;
  if (typeof crs === "string") return crs;
  if (typeof crs === "object") {
    const props = (crs as { properties?: { name?: unknown } }).properties;
    if (props && typeof props.name === "string") return props.name;
  }
  return "__invalid__";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function samePoint(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Signed planar area (shoelace) in degree² — used for orientation only. */
function signedArea(ring: Ring): number {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!;
    const b = ring[i + 1]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Geodesic ring area on a sphere (m²), same approach as Chamberlain & Duquette (2007). */
export function ringAreaM2(ring: Ring): number {
  const n = ring.length;
  if (n < 4) return 0;
  const rad = Math.PI / 180;
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const p1 = ring[i]!;
    const p2 = ring[i + 1]!;
    total += (p2[0] - p1[0]) * rad * (2 + Math.sin(p1[1] * rad) + Math.sin(p2[1] * rad));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

export function polygonAreaM2(rings: Ring[]): number {
  if (rings.length === 0) return 0;
  const [shell, ...holes] = rings;
  return Math.max(0, ringAreaM2(shell!) - holes.reduce((s, h) => s + ringAreaM2(h), 0));
}

function orient(a: Position, b: Position, c: Position): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function onSegment(a: Position, b: Position, p: Position): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

export function segmentsIntersect(p1: Position, p2: Position, q1: Position, q2: Position): boolean {
  const o1 = orient(p1, p2, q1);
  const o2 = orient(p1, p2, q2);
  const o3 = orient(q1, q2, p1);
  const o4 = orient(q1, q2, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, p2, q2)) return true;
  if (o3 === 0 && onSegment(q1, q2, p1)) return true;
  if (o4 === 0 && onSegment(q1, q2, p2)) return true;
  return false;
}

/** Returns the first pair of non-adjacent segments that intersect, if any. */
export function findSelfIntersection(ring: Ring): [number, number] | undefined {
  const segs = ring.length - 1;
  for (let i = 0; i < segs; i++) {
    for (let j = i + 1; j < segs; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === segs - 1);
      if (adjacent) {
        // Adjacent segments share one vertex. They are only invalid when they fold
        // back on each other (a "spike"): collinear and pointing the same way.
        const shared = j === i + 1 ? ring[i + 1]! : ring[0]!;
        const a = j === i + 1 ? ring[i]! : ring[1]!;
        const c = j === i + 1 ? ring[j + 1]! : ring[segs - 1]!;
        const collinear = orient(a, shared, c) === 0;
        const dot = (a[0] - shared[0]) * (c[0] - shared[0]) + (a[1] - shared[1]) * (c[1] - shared[1]);
        if (collinear && dot > 0) return [i, j];
        continue;
      }
      if (segmentsIntersect(ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!)) return [i, j];
    }
  }
  return undefined;
}

function ringsIntersect(a: Ring, b: Ring): boolean {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (segmentsIntersect(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!)) return true;
    }
  }
  return false;
}

export function pointInRing(p: Position, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const intersects = a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

const COORD_PRECISION = 1e7; // ~1.1 cm at the equator

function roundPos(p: Position): [number, number] {
  return [Math.round(p[0] * COORD_PRECISION) / COORD_PRECISION, Math.round(p[1] * COORD_PRECISION) / COORD_PRECISION];
}

function canonicalRing(ring: Ring, wantCcw: boolean): string {
  const open = ring.slice(0, -1).map(roundPos);
  const closed = [...open, open[0]!];
  const ccw = signedArea(closed) > 0;
  const oriented = ccw === wantCcw ? open : [...open].reverse();
  let start = 0;
  for (let i = 1; i < oriented.length; i++) {
    const a = oriented[i]!;
    const b = oriented[start]!;
    if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) start = i;
  }
  const rotated = [...oriented.slice(start), ...oriented.slice(0, start)];
  return rotated.map((p) => `${p[0]},${p[1]}`).join(";");
}

/**
 * Orientation-, start-vertex- and precision-normalised representation of a
 * geometry. Two submissions of the same shape produce the same key. Hash it
 * (SHA-256) before storing.
 */
export function canonicalGeometryKey(g: BoundaryGeometry): string {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  const parts = polys.map((rings) => {
    const [shell, ...holes] = rings;
    const holeKeys = holes.map((h) => canonicalRing(h, false)).sort();
    return [canonicalRing(shell!, true), ...holeKeys].join("|");
  });
  return parts.sort().join("#");
}

/** Normalises a valid geometry to RFC 7946 winding: exterior CCW, holes CW. */
export function normaliseWinding(g: BoundaryGeometry): BoundaryGeometry {
  const fix = (rings: Ring[]): Ring[] =>
    rings.map((ring, idx) => {
      const ccw = signedArea(ring) > 0;
      const want = idx === 0;
      return ccw === want ? ring : [...ring].reverse();
    });
  return g.type === "Polygon"
    ? { type: "Polygon", coordinates: fix(g.coordinates) }
    : { type: "MultiPolygon", coordinates: g.coordinates.map(fix) };
}

export function validateBoundary(
  input: unknown,
  limits: GeometryLimits = DEFAULT_GEOMETRY_LIMITS,
  opts: { existingCanonicalKeys?: ReadonlySet<string> } = {},
): GeometryValidationResult {
  const issues: GeometryIssue[] = [];
  const fail = (): GeometryValidationResult => ({ valid: false, issues, vertexCount, crs: "OGC:CRS84" });
  let vertexCount = 0;

  const { geometry, crs, error } = extractGeometry(input);
  if (error) {
    issues.push(error);
    return fail();
  }

  const name = crsName(crs);
  if (name !== undefined && !ACCEPTED_CRS.includes(name)) {
    issues.push({ code: "UNSUPPORTED_CRS", message: `CRS "${name}" is not supported; submit WGS 84 lon/lat` });
    return fail();
  }

  if (typeof geometry !== "object" || geometry === null) {
    issues.push({ code: "INVALID_STRUCTURE", message: "geometry is missing" });
    return fail();
  }
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (g.type !== "Polygon" && g.type !== "MultiPolygon") {
    issues.push({ code: "UNSUPPORTED_GEOMETRY_TYPE", message: "boundary must be a Polygon or MultiPolygon" });
    return fail();
  }
  if (!Array.isArray(g.coordinates)) {
    issues.push({ code: "INVALID_STRUCTURE", message: "coordinates must be an array" });
    return fail();
  }
  if (depthOf(g.coordinates, limits.maxDepth) > limits.maxDepth) {
    issues.push({ code: "INPUT_TOO_DEEP", message: "coordinates are nested too deeply" });
    return fail();
  }

  const polygonsRaw: unknown[] = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  if (polygonsRaw.length === 0) {
    issues.push({ code: "INVALID_STRUCTURE", message: "no polygons supplied" });
    return fail();
  }
  if (polygonsRaw.length > limits.maxPolygons) {
    issues.push({ code: "TOO_MANY_POLYGONS", message: `at most ${limits.maxPolygons} polygons are allowed` });
    return fail();
  }

  // Structural pass: count vertices before doing any O(n²) work.
  for (const poly of polygonsRaw) {
    if (!Array.isArray(poly)) {
      issues.push({ code: "INVALID_STRUCTURE", message: "polygon must be an array of rings" });
      return fail();
    }
    for (const ring of poly) {
      if (!Array.isArray(ring)) {
        issues.push({ code: "INVALID_STRUCTURE", message: "ring must be an array of positions" });
        return fail();
      }
      vertexCount += ring.length;
      if (vertexCount > limits.maxVertices) {
        issues.push({ code: "TOO_MANY_VERTICES", message: `at most ${limits.maxVertices} vertices are allowed` });
        return fail();
      }
    }
  }

  const polygons: Ring[][] = [];
  let minLon = Infinity;
  let maxLon = -Infinity;

  polygonsRaw.forEach((polyRaw, pi) => {
    const poly = polyRaw as unknown[];
    if (poly.length === 0) {
      issues.push({ code: "INVALID_STRUCTURE", message: "polygon has no rings", path: [pi] });
      return;
    }
    if (poly.length > limits.maxRingsPerPolygon) {
      issues.push({ code: "TOO_MANY_RINGS", message: `at most ${limits.maxRingsPerPolygon} rings per polygon`, path: [pi] });
      return;
    }
    const rings: Ring[] = [];
    poly.forEach((ringRaw, ri) => {
      const ring = ringRaw as unknown[];
      const positions: Position[] = [];
      for (let vi = 0; vi < ring.length; vi++) {
        const p = ring[vi];
        if (!Array.isArray(p) || p.length < 2 || p.length > 3 || !p.every(isFiniteNumber)) {
          issues.push({ code: "INVALID_COORDINATE", message: "position must be [lon, lat] or [lon, lat, alt] numbers", path: [pi, ri, vi] });
          return;
        }
        const [lon, lat] = p as number[];
        if (lon! < -180 || lon! > 180 || lat! < -90 || lat! > 90) {
          issues.push({ code: "INVALID_COORDINATE", message: "longitude must be within ±180 and latitude within ±90", path: [pi, ri, vi] });
          return;
        }
        positions.push([lon!, lat!]);
        minLon = Math.min(minLon, lon!);
        maxLon = Math.max(maxLon, lon!);
      }
      if (positions.length < 4) {
        issues.push({ code: "RING_TOO_FEW_POSITIONS", message: "a ring needs at least 4 positions (3 distinct + closing)", path: [pi, ri] });
        return;
      }
      if (!samePoint(positions[0]!, positions[positions.length - 1]!)) {
        issues.push({ code: "RING_NOT_CLOSED", message: "first and last positions of a ring must be identical", path: [pi, ri] });
        return;
      }
      // Drop consecutive duplicates; they are harmless but break degeneracy checks.
      const deduped = positions.filter((pos, i) => i === 0 || !samePoint(pos, positions[i - 1]!));
      // Zero signed area alone is not enough: a symmetric bow-tie also sums to zero
      // and should be reported as a self-intersection, not as degenerate.
      const allCollinear = deduped.every((p) => orient(deduped[0]!, deduped[1]!, p) === 0);
      if (deduped.length < 4 || allCollinear) {
        issues.push({ code: "RING_DEGENERATE", message: "ring has zero area", path: [pi, ri] });
        return;
      }
      rings.push(deduped);
    });
    polygons.push(rings);
  });

  if (issues.length > 0) return fail();

  if (maxLon - minLon > 180) {
    issues.push({
      code: "ANTIMERIDIAN_CROSSING",
      message: "boundaries crossing the antimeridian must be split into a MultiPolygon",
    });
    return fail();
  }

  polygons.forEach((rings, pi) => {
    rings.forEach((ring, ri) => {
      const hit = findSelfIntersection(ring);
      if (hit) {
        issues.push({ code: "SELF_INTERSECTION", message: `ring edges ${hit[0]} and ${hit[1]} intersect`, path: [pi, ri] });
      }
    });
    const [shell, ...holes] = rings;
    holes.forEach((hole, hi) => {
      if (ringsIntersect(shell!, hole)) {
        issues.push({ code: "RINGS_INTERSECT", message: "hole touches or crosses the exterior ring", path: [pi, hi + 1] });
      } else if (!pointInRing(hole[0]!, shell!)) {
        issues.push({ code: "HOLE_OUTSIDE_SHELL", message: "hole lies outside the exterior ring", path: [pi, hi + 1] });
      }
    });
    for (let a = 0; a < holes.length; a++) {
      for (let b = a + 1; b < holes.length; b++) {
        if (ringsIntersect(holes[a]!, holes[b]!)) {
          issues.push({ code: "RINGS_INTERSECT", message: "holes intersect each other", path: [pi, a + 1] });
        }
      }
    }
  });
  if (issues.length > 0) return fail();

  const normalised = normaliseWinding(
    g.type === "Polygon" ? { type: "Polygon", coordinates: polygons[0]! } : { type: "MultiPolygon", coordinates: polygons },
  );
  const areaM2 = polygons.reduce((s, rings) => s + polygonAreaM2(rings), 0);
  if (areaM2 < limits.minAreaM2) {
    issues.push({ code: "AREA_TOO_SMALL", message: `area must be at least ${limits.minAreaM2} m²` });
  }
  if (areaM2 > limits.maxAreaM2) {
    issues.push({ code: "AREA_TOO_LARGE", message: `area must be at most ${limits.maxAreaM2} m²` });
  }

  const canonicalKey = canonicalGeometryKey(normalised);
  if (opts.existingCanonicalKeys?.has(canonicalKey)) {
    issues.push({ code: "DUPLICATE_GEOMETRY", message: "an identical boundary already exists for this tenant" });
  }

  return {
    valid: issues.length === 0,
    issues,
    geometry: normalised,
    vertexCount,
    areaM2,
    canonicalKey,
    crs: "OGC:CRS84",
  };
}

/** Builds a closed square polygon around a point; used by "enter GPS coordinates" onboarding. */
export function squareAround(lon: number, lat: number, halfSideM: number): PolygonGeometry {
  const dLat = halfSideM / 111_320;
  const dLon = halfSideM / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 1e-6));
  const ring: Ring = [
    [lon - dLon, lat - dLat],
    [lon + dLon, lat - dLat],
    [lon + dLon, lat + dLat],
    [lon - dLon, lat + dLat],
    [lon - dLon, lat - dLat],
  ];
  return { type: "Polygon", coordinates: [ring] };
}

/** Centroid of the exterior ring(s) by vertex average — adequate for map centring, not for surveying. */
export function approximateCentroid(g: BoundaryGeometry): [number, number] {
  const rings = g.type === "Polygon" ? [g.coordinates[0]!] : g.coordinates.map((p) => p[0]!);
  let x = 0;
  let y = 0;
  let n = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      x += ring[i]![0];
      y += ring[i]![1];
      n++;
    }
  }
  return [x / n, y / n];
}
