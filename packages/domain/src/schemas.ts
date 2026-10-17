/**
 * Zod schemas for API request bodies. The OpenAPI document in
 * @metafarm/contracts mirrors these; contract tests keep them in sync.
 */
import { z } from "zod";
import { PROVENANCE_LABELS } from "./provenance";
import { NFT_ASSET_TYPES, NFT_DISCLOSURE, NFT_METADATA_SCHEMA_VERSION, NFT_UTILITIES } from "./nft";
import { METRICS } from "./observations";

export const uuid = z.string().uuid();

export const createFarmSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).optional(),
  /** Optional starting point when the user enters coordinates instead of drawing. */
  origin: z
    .object({
      lon: z.number().min(-180).max(180),
      lat: z.number().min(-90).max(90),
    })
    .optional(),
  timezone: z.string().max(64).default("UTC"),
});

export const submitBoundarySchema = z.object({
  /** GeoJSON Polygon/MultiPolygon, Feature, or single-feature FeatureCollection. Validated in depth by validateBoundary. */
  geojson: z.unknown(),
  source: z.enum(["drawn", "imported", "coordinates"]),
  note: z.string().max(1_000).optional(),
});

export const scenarioRangeSchema = z.object({
  low: z.number().nonnegative(),
  base: z.number().nonnegative(),
  high: z.number().nonnegative(),
});

export const cropScenarioSchema = z.object({
  cropName: z.string().trim().min(1).max(120),
  plantedAreaHa: z.number().positive().optional(),
  yieldPerHa: scenarioRangeSchema,
  yieldUnit: z.string().trim().min(1).max(32),
  pricePerUnit: scenarioRangeSchema,
  costs: scenarioRangeSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  assumptionsNote: z.string().max(2_000).optional(),
});

export const farmPlanSchema = z.object({
  name: z.string().trim().min(1).max(120),
  season: z.string().trim().max(64).optional(),
  parcels: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(80),
        cropName: z.string().trim().max(120).optional(),
        /** Rows/columns of an illustrative planting grid used by the 3D scene. */
        grid: z.object({
          rows: z.number().int().min(1).max(500),
          cols: z.number().int().min(1).max(500),
          spacingM: z.number().positive().max(50),
        }),
        assetCatalogId: uuid.optional(),
      }),
    )
    .max(200),
});

export const createObservationSchema = z.object({
  metric: z.enum(Object.keys(METRICS) as [keyof typeof METRICS, ...(keyof typeof METRICS)[]]),
  value: z.union([z.number(), z.string().max(4_000)]),
  unit: z.string().min(1).max(32),
  observedAt: z.string().datetime({ offset: true }),
  sensorId: uuid.optional(),
});

export const ackAlertSchema = z.object({ note: z.string().max(1_000).optional() });

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(200),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

/** URL-safe slug from a workspace name plus a random suffix (names need not be unique). */
export function workspaceSlug(name: string, suffix: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `${base || "workspace"}-${suffix}`;
}

export const createUploadSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.enum([
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
    "application/geo+json",
    "model/gltf-binary",
  ]),
  byteSize: z.number().int().positive(),
  purpose: z.enum(["boundary-import", "observation-photo", "verification-evidence", "asset-model"]),
  farmId: uuid.optional(),
  /** Hex SHA-256 the client computed; the object store enforces it on PUT where supported. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const walletVerifySchema = z.object({
  message: z.string().min(1).max(2_000),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

export const nftMetadataSchema = z
  .object({
    schema_version: z.literal(NFT_METADATA_SCHEMA_VERSION),
    asset_type: z.enum(NFT_ASSET_TYPES),
    name: z.string().min(1).max(100),
    description: z.string().max(1_000),
    image: z.string().url().optional(),
    application_utility: z.array(z.enum(NFT_UTILITIES)).min(1),
    provenance_label: z.enum(PROVENANCE_LABELS),
    source_timestamp: z.string().datetime({ offset: true }),
    license_reference: z.string().min(1).max(200),
    terms_url: z.string().url(),
    disclosure: z.literal(NFT_DISCLOSURE),
    attributes: z
      .array(z.object({ trait_type: z.string().max(64), value: z.union([z.string().max(200), z.number()]) }))
      .max(20)
      .optional(),
  })
  .strict();

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export type CreateFarmInput = z.infer<typeof createFarmSchema>;
export type SubmitBoundaryInput = z.infer<typeof submitBoundarySchema>;
export type CropScenarioBody = z.infer<typeof cropScenarioSchema>;
export type FarmPlanInput = z.infer<typeof farmPlanSchema>;
export type CreateObservationInput = z.infer<typeof createObservationSchema>;
export type CreateUploadInput = z.infer<typeof createUploadSchema>;
