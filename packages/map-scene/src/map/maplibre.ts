/// <reference types="geojson" />
import type { BoundaryGeometry } from "@metafarm/domain/geometry";
import type { BasemapConfig, MapAdapter, MapHandle } from "./adapter";
import { MOCK_ATTRIBUTION, mockStyle } from "./mock-style";

const BOUNDARY_SOURCE = "mf-boundary";
const DRAFT_SOURCE = "mf-draft";

/** MapLibre GL JS adapter. maplibre-gl is imported lazily so it stays out of the initial bundle. */
export function createMapLibreAdapter(config: BasemapConfig = {}): MapAdapter {
  return {
    name: "maplibre",
    async mount(container, opts): Promise<MapHandle> {
      // MapLibre 6 is ESM-only with no default export.
      const maplibre = await import("maplibre-gl");
      const map = new maplibre.Map({
        container,
        style: (config.styleUrl || mockStyle()) as never,
        center: opts.center,
        zoom: opts.zoom,
        attributionControl: false,
        // Keyboard pan/zoom stays enabled; MapLibre's canvas is focusable.
        keyboard: true,
        fadeDuration: opts.reducedMotion ? 0 : 300,
      });
      map.addControl(new maplibre.AttributionControl({ compact: true, customAttribution: config.attribution || MOCK_ATTRIBUTION }));
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
      map.getCanvas().setAttribute("aria-label", "Map. Use arrow keys to pan and plus or minus to zoom. Coordinates can also be entered in the form.");

      await new Promise<void>((resolve) => (map.loaded() ? resolve() : map.once("load", () => resolve())));

      const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
      map.addSource(BOUNDARY_SOURCE, { type: "geojson", data: empty });
      map.addSource(DRAFT_SOURCE, { type: "geojson", data: empty });
      map.addLayer({ id: "mf-boundary-fill", type: "fill", source: BOUNDARY_SOURCE, paint: { "fill-color": "#2b4c7e", "fill-opacity": 0.15 } });
      map.addLayer({ id: "mf-boundary-line", type: "line", source: BOUNDARY_SOURCE, paint: { "line-color": "#2b4c7e", "line-width": 2 } });
      map.addLayer({ id: "mf-draft-line", type: "line", source: DRAFT_SOURCE, paint: { "line-color": "#b5452f", "line-width": 2, "line-dasharray": [2, 1] } });
      map.addLayer({ id: "mf-draft-points", type: "circle", source: DRAFT_SOURCE, paint: { "circle-radius": 5, "circle-color": "#b5452f" } });

      const setData = (id: string, data: GeoJSON.GeoJSON) => (map.getSource(id) as { setData(d: GeoJSON.GeoJSON): void } | undefined)?.setData(data);

      return {
        setBoundary(geometry: BoundaryGeometry | null) {
          setData(BOUNDARY_SOURCE, geometry ? { type: "Feature", properties: {}, geometry } : empty);
        },
        setDraft(points) {
          const features: GeoJSON.Feature[] = points.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } }));
          if (points.length > 1) features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: points } });
          setData(DRAFT_SOURCE, { type: "FeatureCollection", features });
        },
        flyTo(lon, lat, zoom = 15) {
          if (opts.reducedMotion) map.jumpTo({ center: [lon, lat], zoom });
          else map.flyTo({ center: [lon, lat], zoom });
        },
        fitBounds(bbox) {
          map.fitBounds(bbox, { padding: 40, animate: !opts.reducedMotion });
        },
        onClick(cb) {
          const handler = (e: { lngLat: { lng: number; lat: number } }) => cb({ lon: e.lngLat.lng, lat: e.lngLat.lat });
          map.on("click", handler);
          return () => map.off("click", handler);
        },
        destroy() {
          // Releases the WebGL context and DOM listeners.
          map.remove();
        },
      };
    },
  };
}
