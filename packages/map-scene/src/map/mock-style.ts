/**
 * Offline mock basemap: background colour plus a 1° graticule generated
 * locally. It contains no imagery, roads or labels and is clearly marked as a
 * placeholder, so it can never be mistaken for real geographic data.
 */
export function graticule(stepDeg = 1): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  for (let lon = -180; lon <= 180; lon += stepDeg) {
    features.push({ type: "Feature", properties: { kind: "meridian" }, geometry: { type: "LineString", coordinates: [[lon, -85], [lon, 85]] } });
  }
  for (let lat = -80; lat <= 80; lat += stepDeg) {
    features.push({ type: "Feature", properties: { kind: "parallel" }, geometry: { type: "LineString", coordinates: [[-180, lat], [180, lat]] } });
  }
  return { type: "FeatureCollection", features };
}

export function mockStyle(): Record<string, unknown> {
  return {
    version: 8,
    name: "metafarm-mock (no basemap configured)",
    sources: {
      graticule: { type: "geojson", data: graticule(0.25) },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#eef1ec" } },
      { id: "graticule", type: "line", source: "graticule", paint: { "line-color": "#c9d2c4", "line-width": 1 } },
    ],
  };
}

export const MOCK_ATTRIBUTION = "Placeholder map — no basemap provider configured";
