import { getBoundaryVersion, getFarm, withTenant, writeAudit, type Pool } from "@metafarm/db";
import { NonRetryableJobError, type ImageryIngestionJob } from "@metafarm/domain";
import type { Handler } from "../runner";

export interface ImageryScene {
  providerSceneId: string;
  acquiredAt: string;
  cloudCoverPercent?: number;
  /** Storage key or provider URL of the asset; never fetched from user-supplied URLs. */
  assetRef: string;
  license: string;
}

/**
 * Imagery provider integration point.
 *
 * TODO(provider-config): implement this interface for your chosen imagery
 * provider. Accuracy, revisit time, resolution and licence terms are entirely
 * determined by that provider; this application makes no claims about them.
 * Provider endpoints must be fixed configuration — never derived from request
 * data — to avoid server-side request forgery.
 */
export interface ImageryProvider {
  readonly name: string;
  searchScenes(bbox: [number, number, number, number], from: string, to: string): Promise<ImageryScene[]>;
}

/** Default: no provider configured. Returns nothing; we do not fabricate imagery. */
export const noImageryProvider: ImageryProvider = {
  name: "none",
  async searchScenes() {
    return [];
  },
};

export function imageryIngestionHandler(pool: Pool, provider: ImageryProvider): Handler<ImageryIngestionJob> {
  return async (job, { log }) => {
    if (provider.name === "none") {
      log.info("no imagery provider configured; nothing to ingest");
      return { scenes: 0, provider: "none" };
    }
    const bbox = await withTenant(pool, job.tenantId, async (tx) => {
      const farm = await getFarm(tx, job.farmId);
      if (!farm?.current_boundary_version_id) throw new NonRetryableJobError("farm has no validated boundary");
      const b = await getBoundaryVersion(tx, job.farmId, farm.current_boundary_version_id);
      if (!b) throw new NonRetryableJobError("boundary missing");
      const polygons = b.geojson.type === "MultiPolygon" ? b.geojson.coordinates : [b.geojson.coordinates];
      const coords = polygons.flatMap((rings) => rings.flatMap((ring) => ring));
      const xs = coords.map((c) => c[0]);
      const ys = coords.map((c) => c[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number];
    });

    const scenes = await provider.searchScenes(bbox, job.from, job.to);
    await withTenant(pool, job.tenantId, async (tx) => {
      // Scenes are recorded as provider observations of availability only. Deriving
      // indices (e.g. NDVI) belongs in a separate, provider-specific processing step.
      await writeAudit(tx, {
        actorType: "job",
        action: "imagery.search_completed",
        targetType: "farm",
        targetId: job.farmId,
        metadata: { provider: provider.name, scenes: scenes.length, from: job.from, to: job.to },
      });
    });
    log.info({ scenes: scenes.length, provider: provider.name }, "imagery search complete");
    return { scenes: scenes.length, provider: provider.name };
  };
}
