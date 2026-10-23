/**
 * Optional globe / terrain / 3D Tiles integration behind an adapter.
 *
 * Cesium is NOT a dependency of this repository and no paid provider is
 * required. The default adapter is disabled and the UI simply hides globe
 * features. To enable it:
 *   1. `pnpm --filter @metafarm/web add cesium`
 *   2. set NEXT_PUBLIC_CESIUM_ENABLED=true
 *   3. Decision pending (docs/provider-capabilities.md, "globe"): choose terrain/tiles sources. Cesium works with
 *      open data (e.g. self-hosted 3D Tiles or an ellipsoid with no terrain);
 *      a Cesium ion token is only needed if you choose ion-hosted assets.
 * Large-area georeferenced content belongs here; the local farm scene stays in
 * three.js with a local coordinate frame.
 */
export interface GlobeHandle {
  flyTo(lon: number, lat: number, heightM: number): void;
  /** Adds a 3D Tiles tileset from a URL you control. Returns a removal function. */
  addTileset(url: string): Promise<() => void>;
  destroy(): void;
}

export interface CesiumAdapter {
  readonly enabled: boolean;
  mount(container: HTMLElement): Promise<GlobeHandle>;
}

export const disabledCesiumAdapter: CesiumAdapter = {
  enabled: false,
  async mount() {
    throw new Error("Cesium integration is disabled (NEXT_PUBLIC_CESIUM_ENABLED is not true)");
  },
};

/**
 * Loads Cesium on demand. The module specifier is computed so bundlers and
 * the type checker do not require `cesium` to be installed.
 */
export function createCesiumAdapter(opts: { enabled: boolean; baseUrl?: string }): CesiumAdapter {
  if (!opts.enabled) return disabledCesiumAdapter;
  return {
    enabled: true,
    async mount(container) {
      const specifier = "cesium";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Cesium: any = await import(/* webpackIgnore: true */ specifier);
      if (opts.baseUrl) (globalThis as Record<string, unknown>).CESIUM_BASE_URL = opts.baseUrl;
      const viewer = new Cesium.Viewer(container, {
        baseLayerPicker: false,
        geocoder: false,
        timeline: false,
        animation: false,
        // No default imagery provider: avoids silently depending on a hosted service.
        baseLayer: false,
        terrain: undefined,
      });
      return {
        flyTo(lon, lat, heightM) {
          viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lon, lat, heightM) });
        },
        async addTileset(url) {
          const tileset = await Cesium.Cesium3DTileset.fromUrl(url);
          viewer.scene.primitives.add(tileset);
          return () => viewer.scene.primitives.remove(tileset);
        },
        destroy() {
          viewer.destroy();
        },
      };
    },
  };
}
