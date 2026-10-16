import { approximateCentroid, type BoundaryGeometry } from "@metafarm/domain/geometry";
import { pointInPolygon2D, toLocal, type LonLat } from "./local-frame";
import { hashString, mulberry32 } from "./prng";

export type EntityKind = "plant" | "equipment" | "structure" | "decoration" | "sensor";

export interface SceneEntity {
  /** Stable id: same plan → same id on every load, so selection and URLs survive reloads. */
  id: string;
  kind: EntityKind;
  assetId: string;
  label?: string;
  x: number;
  z: number;
  rotation: number;
  scale: number;
  provenance: "illustrative" | "user-entered";
}

export interface SceneDescription {
  farmId: string;
  seed: number;
  origin: LonLat | null;
  boundaryLocal: [number, number][][];
  entities: SceneEntity[];
  disclaimer: string;
}

export interface ScenePlanParcel {
  label: string;
  cropName?: string;
  grid: { rows: number; cols: number; spacingM: number };
  assetCatalogId?: string;
}

export interface SceneCatalogEntry {
  id: string;
  kind: string;
  name: string;
}

export const SCENE_DISCLAIMER =
  "Illustrative 3D visualisation. Plant positions, sizes and equipment are generated for display and are not a survey, " +
  "an inventory, or evidence of real-world conditions.";

export const MAX_SCENE_ENTITIES = 20_000;

/**
 * Builds a deterministic scene from the farm's origin, its current boundary
 * and its plan. Given the same inputs it always returns the same output
 * (seeded PRNG, stable ordering, millimetre rounding), which keeps 3D test
 * fixtures and snapshots stable.
 */
export function buildScene(input: {
  farmId: string;
  origin: LonLat | null;
  boundary: BoundaryGeometry | null;
  parcels: ScenePlanParcel[];
  catalog: SceneCatalogEntry[];
  maxEntities?: number;
}): SceneDescription {
  const seed = hashString(input.farmId);
  const rand = mulberry32(seed);
  const max = Math.min(input.maxEntities ?? MAX_SCENE_ENTITIES, MAX_SCENE_ENTITIES);

  const origin: LonLat | null =
    input.origin ??
    (input.boundary
      ? (() => {
          const [lon, lat] = approximateCentroid(input.boundary!);
          return { lon, lat };
        })()
      : null);

  const boundaryLocal: [number, number][][] =
    origin && input.boundary
      ? (input.boundary.type === "Polygon" ? [input.boundary.coordinates[0]!] : input.boundary.coordinates.map((p) => p[0]!)).map(
          (ring) => ring.map(([lon, lat]) => toLocal(origin, lon, lat)),
        )
      : [];

  const plants = [...input.catalog].filter((c) => c.kind === "plant").sort((a, b) => a.id.localeCompare(b.id));
  const defaultPlant = plants[0]?.id ?? "procedural:plant";
  const entities: SceneEntity[] = [];

  // Lay parcels out left-to-right with a gap, centred on the origin. If a boundary
  // exists, positions outside it are skipped so plants stay inside the drawn area.
  const parcels = [...input.parcels].sort((a, b) => a.label.localeCompare(b.label));
  const widths = parcels.map((p) => (p.grid.cols - 1) * p.grid.spacingM);
  const gap = 4;
  const total = widths.reduce((s, w) => s + w, 0) + gap * Math.max(0, parcels.length - 1);
  let cursorX = -total / 2;

  outer: for (let pi = 0; pi < parcels.length; pi++) {
    const p = parcels[pi]!;
    const depth = (p.grid.rows - 1) * p.grid.spacingM;
    const assetId = p.assetCatalogId ?? defaultPlant;
    for (let r = 0; r < p.grid.rows; r++) {
      for (let c = 0; c < p.grid.cols; c++) {
        // Consume PRNG values unconditionally so skipping one position never shifts the rest.
        const jx = (rand() - 0.5) * p.grid.spacingM * 0.2;
        const jz = (rand() - 0.5) * p.grid.spacingM * 0.2;
        const rot = rand() * Math.PI * 2;
        const scl = 0.85 + rand() * 0.3;
        const x = round3(cursorX + c * p.grid.spacingM + jx);
        const z = round3(-depth / 2 + r * p.grid.spacingM + jz);
        if (boundaryLocal.length > 0 && !boundaryLocal.some((ring) => pointInPolygon2D(x, z, ring))) continue;
        if (entities.length >= max) break outer;
        entities.push({
          id: `${slug(p.label)}:r${r}c${c}`,
          kind: "plant",
          assetId,
          label: p.cropName ? `${p.cropName} (${p.label}, row ${r + 1}, column ${c + 1})` : `${p.label}, row ${r + 1}, column ${c + 1}`,
          x,
          z,
          rotation: round3(rot),
          scale: round3(scl),
          provenance: "illustrative",
        });
      }
    }
    cursorX += widths[pi]! + gap;
  }

  return { farmId: input.farmId, seed, origin, boundaryLocal, entities, disclaimer: SCENE_DISCLAIMER };
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "parcel";
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000 + 0;
}
