/** Fits a lon/lat ring into a 100×100 box with padding; returns an SVG path. */
export function outlinePath(ring: number[][], pad = 10): string {
  const meanLat = ring.reduce((s, p) => s + p[1]!, 0) / ring.length;
  const kx = Math.cos((meanLat * Math.PI) / 180) || 1;
  const pts = ring.map(([lon, lat]) => [lon! * kx, lat!] as const);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = (100 - pad * 2) / span;
  // Centre the shorter side.
  const ox = pad + (100 - pad * 2 - (maxX - minX) * scale) / 2;
  const oy = pad + (100 - pad * 2 - (maxY - minY) * scale) / 2;
  return (
    pts
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${(ox + (x - minX) * scale).toFixed(2)} ${(oy + (maxY - y) * scale).toFixed(2)}`)
      .join(" ") + " Z"
  );
}
