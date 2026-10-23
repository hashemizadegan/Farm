/**
 * Web provider capabilities at runtime. next.config.ts checks the providers at build time (packages/config
 * capabilities.ts: map tiles, globe imagery, browser uploads) and fails the build on an incomplete or unsafe
 * configuration; it passes the map-tiles state to the bundle, so the browser uses a tile provider only when that check
 * enabled it. Anything else is the built-in offline style (no imagery is fabricated).
 */
export interface MapTilesConfig {
  styleUrl: string | undefined;
  /** Attribution text to add; undefined when the style carries its own (`from-style`) or tiles are off. */
  attribution: string | undefined;
}

export function mapTilesConfig(
  env: { state?: string; styleUrl?: string; attribution?: string } = {
    state: process.env.NEXT_PUBLIC_MAP_TILES_STATE,
    styleUrl: process.env.NEXT_PUBLIC_MAP_STYLE_URL,
    attribution: process.env.NEXT_PUBLIC_MAP_ATTRIBUTION,
  },
): MapTilesConfig {
  if (env.state !== "enabled" || !env.styleUrl) return { styleUrl: undefined, attribution: undefined };
  return { styleUrl: env.styleUrl, attribution: env.attribution === "from-style" ? undefined : env.attribution };
}
