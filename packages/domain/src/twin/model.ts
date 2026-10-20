/**
 * The farm's digital twin, as a separate 3D client sees it. The twin adds no second asset registry:
 * every object is a `business_assets` row (the physical identity), shown on a layer of the scene
 * (the twin identity), with zero or more on-chain representations (the chain identity), off-chain
 * data commitments, an operational status, and ownership read from the chain.
 *
 * | Concern               | Where it lives                                                  |
 * | --------------------- | --------------------------------------------------------------- |
 * | physical identity     | `business_assets`: kind, name, external ref, surveyed geometry  |
 * | digital-twin identity | `twinObjectId` + `layer`, derived from the asset (never stored) |
 * | blockchain identity   | `asset_representations`: rail, network, mint or asset id        |
 * | off-chain references  | `data_commitments`: content hash, schema, storage ref, batch    |
 * | operational status    | `business_assets.status` and representation status             |
 * | ownership / transfers | the chain, through an `OwnershipReader`; never a database row   |
 */
import { z } from "zod";
import { ASSET_KINDS, type AssetKind } from "../rwa/model";

export const TWIN_SCENE_SCHEME = "metafarm-twin-scene/1";

/** Scene layers. `terrain` is the farm's own boundary; the others hold assets. */
export const TWIN_LAYERS = [
  "terrain",
  "plots",
  "crops_trees",
  "livestock",
  "equipment",
  "buildings",
  "storage",
  "output_batches",
  "logistics",
  "shares",
] as const;
export type TwinLayer = (typeof TWIN_LAYERS)[number];

const LAYER_OF: Record<AssetKind, TwinLayer> = {
  parcel: "plots",
  tree: "crops_trees",
  livestock: "livestock",
  equipment: "equipment",
  building: "buildings",
  storage_unit: "storage",
  harvest_lot: "output_batches",
  logistics_lot: "logistics",
  farm_share: "shares",
};

export const twinLayerOf = (kind: AssetKind): TwinLayer => LAYER_OF[kind];

/** The twin id of an asset: stable, derived, and distinct from the chain's ids. */
export const twinObjectId = (assetId: string): string => `asset:${assetId}`;

/** What a data commitment is about. */
export const DATA_SUBJECT_TYPES = ["farm", "asset", "telemetry_window", "media", "record", "scene_bundle"] as const;
export type DataSubjectType = (typeof DATA_SUBJECT_TYPES)[number];

/**
 * How far a data commitment has been verified, from the platform's own checks only:
 * - `recorded`: the hash was recorded as submitted; nothing else is proven.
 * - `included`: it is a leaf of a Merkle batch, and the proof to the batch root was re-checked now.
 * - `anchored`: the batch root is in a finalized on-chain transaction the platform checked. Nothing
 *   in this release writes or checks anchors, so this state is never produced yet.
 */
export const DATA_VERIFICATION_STATES = ["recorded", "included", "anchored"] as const;
export type DataVerificationState = (typeof DATA_VERIFICATION_STATES)[number];

export function verificationStateOf(f: { inclusionVerified: boolean; anchorConfirmedOnChain: boolean }): DataVerificationState {
  if (f.inclusionVerified && f.anchorConfirmedOnChain) return "anchored";
  if (f.inclusionVerified) return "included";
  return "recorded";
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "a lowercase hex SHA-256");
const schemaName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export const createDataCommitmentSchema = z
  .object({
    farmId: z.string().uuid().optional(),
    subjectType: z.enum(DATA_SUBJECT_TYPES),
    /** The subject's own id (asset id, media id, a telemetry window like `sensor-id/2026-10-20T10`). */
    subjectId: z.string().min(1).max(200),
    schema: schemaName,
    schemaVersion: z.number().int().min(1).max(10_000),
    contentSha256: sha256,
    byteSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    storageRef: z.string().min(1).max(512).optional(),
    /** When the data was produced at its source (sensor time, survey date). */
    sourceTime: z.string().datetime({ offset: true }),
    /** Reference to an attestation (a signature or certificate id), when the source signed the data. */
    attestationRef: z.string().min(1).max(512).optional(),
  })
  .strict();
export type CreateDataCommitment = z.infer<typeof createDataCommitmentSchema>;

export const createCommitmentBatchSchema = z
  .object({
    /** Free name grouping the batch, e.g. `telemetry/2026-10-20`. */
    dataset: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,99}$/),
    commitmentIds: z.array(z.string().uuid()).min(1).max(4096),
  })
  .strict();

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "a base58 Solana address");

export const transferPreviewSchema = z
  .object({
    representationId: z.string().uuid(),
    from: base58,
    to: base58,
    /** Base units as a decimal string (u64). */
    amount: z.string().regex(/^[1-9][0-9]{0,19}$/),
  })
  .strict();

// ── Responses (also used to check the client starter's sample payloads) ─────────────────────────

const geometry = z.object({ type: z.string(), coordinates: z.unknown() }).passthrough();

export const twinChainIdentitySchema = z.object({
  representationId: z.string().uuid(),
  rail: z.string(),
  network: z.string(),
  status: z.string(),
  /** Mint (Token-2022), asset id (Bubblegum) or contract (TRC-20); null until known. */
  chainId: z.string().nullable(),
});

export const twinObjectSummarySchema = z.object({
  twinObjectId: z.string().regex(/^asset:[0-9a-f-]{36}$/),
  assetId: z.string().uuid(),
  layer: z.enum(TWIN_LAYERS),
  kind: z.enum(ASSET_KINDS),
  name: z.string(),
  status: z.string(),
  geometry: geometry.nullable(),
  physical: z.object({
    externalRef: z.string().nullable(),
    parcelLabel: z.string().nullable(),
    geomProvenance: z.string().nullable(),
    verifiedAt: z.string().nullable(),
  }),
  chain: z.array(twinChainIdentitySchema),
});
export type TwinObjectSummary = z.infer<typeof twinObjectSummarySchema>;

export const twinSceneSchema = z.object({
  scheme: z.literal(TWIN_SCENE_SCHEME),
  generatedAt: z.string(),
  farm: z.object({
    id: z.string().uuid(),
    name: z.string(),
    origin: z.object({ lon: z.number(), lat: z.number() }).nullable(),
    outline: z.array(z.tuple([z.number(), z.number()])).nullable(),
  }),
  /** Layers the caller may not see (e.g. assets without `rwa:read`). */
  redacted: z.array(z.enum(TWIN_LAYERS)),
  objects: z.array(twinObjectSummarySchema),
  /** Pass as `cursor` for the next page of objects; null on the last page. */
  nextCursor: z.string().uuid().nullable(),
});
export type TwinScene = z.infer<typeof twinSceneSchema>;

export const twinOwnershipSchema = z.discriminatedUnion("status", [
  z.object({ representationId: z.string().uuid(), status: z.literal("not_on_chain") }),
  z.object({ representationId: z.string().uuid(), status: z.literal("not_indexed"), reason: z.enum(["no_ownership_reader", "not_covered", "reader_unavailable"]) }),
  z.object({
    representationId: z.string().uuid(),
    status: z.literal("indexed"),
    source: z.enum(["chain_index", "das", "fixture"]),
    assurance: z.enum(["inclusion_verified", "indexer_reported", "fixture"]),
    asOfSlot: z.string().regex(/^[0-9]+$/).nullable(),
    holders: z.array(z.object({ owner: z.string(), amount: z.string().regex(/^[0-9]+$/) })),
  }),
]);

export const dataCommitmentViewSchema = z.object({
  id: z.string().uuid(),
  farmId: z.string().uuid().nullable(),
  subjectType: z.enum(DATA_SUBJECT_TYPES),
  subjectId: z.string(),
  schema: schemaName,
  schemaVersion: z.number().int(),
  contentSha256: sha256,
  byteSize: z.number().int().nullable(),
  storageRef: z.string().nullable(),
  sourceTime: z.string(),
  attestationRef: z.string().nullable(),
  batch: z.object({ id: z.string().uuid(), leafIndex: z.number().int() }).nullable(),
  createdAt: z.string(),
});

export const twinAssetDetailSchema = z.object({
  object: twinObjectSummarySchema,
  lifecycle: z.array(z.object({ event: z.enum(["registered", "verified"]), at: z.string() })),
  ownership: z.array(twinOwnershipSchema),
  dataCommitments: z.array(dataCommitmentViewSchema),
});
export type TwinAssetDetail = z.infer<typeof twinAssetDetailSchema>;
