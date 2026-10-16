/**
 * Renderer quality presets. "auto" picks a preset from coarse device hints;
 * users can override it and the choice is remembered per browser.
 */
export type QualityLevel = "low" | "medium" | "high";

export interface QualityPreset {
  level: QualityLevel;
  /** Upper bound for devicePixelRatio; high-DPI phones otherwise render 9× the pixels. */
  maxDpr: number;
  antialias: boolean;
  shadows: boolean;
  /** Max plant instances drawn; beyond this, instances are thinned deterministically. */
  maxInstances: number;
  /** Segments for procedural geometry. */
  geometryDetail: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: { level: "low", maxDpr: 1, antialias: false, shadows: false, maxInstances: 2_000, geometryDetail: 4 },
  medium: { level: "medium", maxDpr: 1.5, antialias: true, shadows: false, maxInstances: 8_000, geometryDetail: 6 },
  high: { level: "high", maxDpr: 2, antialias: true, shadows: true, maxInstances: 20_000, geometryDetail: 10 },
};

export function capDevicePixelRatio(dpr: number, preset: QualityPreset): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.min(dpr, preset.maxDpr);
}

export function autoQuality(hints: { hardwareConcurrency?: number; deviceMemoryGb?: number; prefersReducedData?: boolean; coarsePointer?: boolean }): QualityLevel {
  if (hints.prefersReducedData) return "low";
  const cores = hints.hardwareConcurrency ?? 4;
  const mem = hints.deviceMemoryGb ?? 4;
  if (cores <= 4 || mem <= 2) return "low";
  if (hints.coarsePointer || cores <= 8 || mem <= 4) return "medium";
  return "high";
}

/** Deterministic thinning: keeps every k-th entity so the same subset is drawn on every load. */
export function thin<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.floor(i * step)]!);
  return out;
}
