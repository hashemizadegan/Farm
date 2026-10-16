import type { BoundaryGeometry } from "@metafarm/domain/geometry";

/**
 * 2D map adapter. Pages talk to this interface, never to MapLibre directly,
 * so the basemap provider can change without touching UI code.
 */
export interface MapHandle {
  setBoundary(geometry: BoundaryGeometry | null): void;
  /** Shows an in-progress drawing (open ring). */
  setDraft(points: [number, number][]): void;
  flyTo(lon: number, lat: number, zoom?: number): void;
  fitBounds(bbox: [number, number, number, number]): void;
  onClick(cb: (lngLat: { lon: number; lat: number }) => void): () => void;
  destroy(): void;
}

export interface MapAdapter {
  readonly name: string;
  mount(container: HTMLElement, opts: { center: [number, number]; zoom: number; reducedMotion: boolean }): Promise<MapHandle>;
}

/** Basemap configuration. Both values come from NEXT_PUBLIC_* env vars. */
export interface BasemapConfig {
  /**
   * TODO(provider-config): URL of a MapLibre style JSON from your tile provider
   * (or a self-hosted style). When empty, the built-in offline mock style is
   * used: a plain background and a graticule, with no imagery or place names.
   */
  styleUrl?: string;
  /** Attribution text required by your provider's terms. */
  attribution?: string;
}
