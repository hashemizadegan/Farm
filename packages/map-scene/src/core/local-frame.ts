/**
 * Local tangent-plane coordinates for the 3D scene.
 *
 * WebGL uses 32-bit floats; rendering raw geographic or ECEF coordinates
 * causes visible jitter. The scene therefore works in metres relative to a
 * farm origin, keeping every vertex near (0, 0, 0).
 *
 * Axis convention (three.js): +x = east, +y = up, +z = south (so -z = north).
 *
 * This equirectangular approximation is accurate to well under 0.1% over a
 * few kilometres, which is adequate for visualisation. It is NOT a survey
 * projection; distances shown in the scene are approximate.
 */
const METRES_PER_DEG_LAT = 111_320;

export interface LonLat {
  lon: number;
  lat: number;
}

export function toLocal(origin: LonLat, lon: number, lat: number): [x: number, z: number] {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const x = (lon - origin.lon) * METRES_PER_DEG_LAT * cosLat;
  const north = (lat - origin.lat) * METRES_PER_DEG_LAT;
  return [round3(x), round3(-north)];
}

export function fromLocal(origin: LonLat, x: number, z: number): LonLat {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  return {
    lon: origin.lon + x / (METRES_PER_DEG_LAT * Math.max(cosLat, 1e-9)),
    lat: origin.lat + -z / METRES_PER_DEG_LAT,
  };
}

function round3(n: number) {
  // Millimetre rounding keeps fixtures deterministic across platforms and removes -0.
  return Math.round(n * 1000) / 1000 + 0;
}

export function pointInPolygon2D(x: number, z: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!;
    const [xj, zj] = ring[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
