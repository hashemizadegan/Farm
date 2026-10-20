/**
 * Farm-state snapshots: a versioned, canonical, hash-addressed record of a farm's entities at one
 * moment, from which the state can be reconstructed and checked without the database.
 *
 * - Each entity is committed on its own: SHA-256 of the canonical JSON of
 *   `{ scheme: "metafarm-record/1", schema: "metafarm.entity.<type>", schemaVersion, record }`
 *   (`commitToRecord`), so one entity can be disclosed and proven without the others.
 * - Entities are ordered by (type, id) and their hashes form an RFC 9162 Merkle tree
 *   (`metafarm-merkle-sha256/1`); the root commits to the whole set.
 * - The snapshot id is SHA-256 of the canonical header (scheme, farm, time, count, root). Storing the
 *   canonical JSON under that id makes it content-addressed.
 *
 * Entity data must be plain JSON: strings, booleans, null, finite numbers, arrays and objects.
 * Anything else (NaN, Infinity, undefined inside arrays, dates, bigints) is refused rather than
 * silently changed, because the hash must survive a round trip through JSON.
 */
import { z } from "zod";
import { canonicalJson } from "../harvest";
import { commitToRecord, contentHash, merkleAuditPath, merkleLeaf, merkleRoot, type InclusionProof, MAX_BATCH_LEAVES } from "./commitments";

export const SNAPSHOT_SCHEME = "metafarm-farm-snapshot/1";
/** Schema name of the data commitment that records a stored snapshot; reserved for the snapshot API. */
export const SNAPSHOT_COMMITMENT_SCHEMA = "metafarm.farm-snapshot";
/** Version of the entity schemas below; bump when an entity's fields change meaning. */
export const SNAPSHOT_ENTITY_SCHEMA_VERSION = 1;

/** What a snapshot may hold. Each maps to an existing platform record (see docs/twin-snapshots.md). */
export const SNAPSHOT_ENTITY_TYPES = ["plot", "crop", "structure", "inventory", "machine", "animal", "asset"] as const;
export type SnapshotEntityType = (typeof SNAPSHOT_ENTITY_TYPES)[number];

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface SnapshotEntityInput {
  type: SnapshotEntityType;
  /** Stable id of the record (a UUID for platform records). */
  id: string;
  data: { [key: string]: JsonValue };
}

export interface SnapshotEntity extends SnapshotEntityInput {
  /** `commitToRecord("metafarm.entity.<type>", SNAPSHOT_ENTITY_SCHEMA_VERSION, data)`. */
  sha256: string;
}

export interface FarmSnapshot {
  scheme: typeof SNAPSHOT_SCHEME;
  /** SHA-256 of the canonical header; the snapshot's content address. */
  snapshotId: string;
  farmId: string;
  takenAt: string;
  entitySchemaVersion: number;
  entityCount: number;
  /** Merkle root over the entity hashes in order. */
  root: string;
  entities: SnapshotEntity[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

/** Checks that a value is plain JSON whose hash survives serialisation; returns the first problem. */
export function plainJsonProblem(value: unknown, path = "data"): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0) ? null : `${path} is not a finite number`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const p = plainJsonProblem(value[i], `${path}[${i}]`);
      if (p) return p;
    }
    return null;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) return `${path}.${k} is undefined`;
      const p = plainJsonProblem(v, `${path}.${k}`);
      if (p) return p;
    }
    return null;
  }
  return `${path} is not plain JSON`;
}

const entityKey = (e: { type: string; id: string }) => `${e.type}\u0000${e.id}`;
const compareEntities = (a: { type: string; id: string }, b: { type: string; id: string }) => (entityKey(a) < entityKey(b) ? -1 : entityKey(a) > entityKey(b) ? 1 : 0);

async function entityHash(e: SnapshotEntityInput): Promise<string> {
  return (await commitToRecord(`metafarm.entity.${e.type}`, SNAPSHOT_ENTITY_SCHEMA_VERSION, e.data)).sha256;
}

async function headerId(h: { farmId: string; takenAt: string; entitySchemaVersion: number; entityCount: number; root: string }): Promise<string> {
  return contentHash(canonicalJson({ scheme: SNAPSHOT_SCHEME, ...h }));
}

/** Builds a snapshot. Refuses duplicates, unknown types, bad ids and data that is not plain JSON. */
export async function buildFarmSnapshot(input: { farmId: string; takenAt: Date; entities: readonly SnapshotEntityInput[] }): Promise<FarmSnapshot> {
  if (!ID.test(input.farmId)) throw new RangeError("farmId is not a valid id");
  if (input.entities.length === 0) throw new RangeError("a snapshot needs at least one entity");
  if (input.entities.length > MAX_BATCH_LEAVES) throw new RangeError(`a snapshot holds at most ${MAX_BATCH_LEAVES} entities; split it by type`);
  const seen = new Set<string>();
  for (const e of input.entities) {
    if (!(SNAPSHOT_ENTITY_TYPES as readonly string[]).includes(e.type)) throw new RangeError(`unknown entity type ${String(e.type)}`);
    if (!ID.test(e.id)) throw new RangeError(`entity id ${JSON.stringify(e.id)} is not valid`);
    if (seen.has(entityKey(e))) throw new RangeError(`duplicate entity ${e.type}/${e.id}`);
    seen.add(entityKey(e));
    const problem = plainJsonProblem(e.data);
    if (problem) throw new RangeError(`${e.type}/${e.id}: ${problem}`);
  }
  const ordered = [...input.entities].sort(compareEntities);
  const entities: SnapshotEntity[] = [];
  for (const e of ordered) entities.push({ type: e.type, id: e.id, data: e.data, sha256: await entityHash(e) });
  const root = await merkleRoot(await Promise.all(entities.map((e) => merkleLeaf(e.sha256))));
  const header = { farmId: input.farmId, takenAt: input.takenAt.toISOString(), entitySchemaVersion: SNAPSHOT_ENTITY_SCHEMA_VERSION, entityCount: entities.length, root };
  return { scheme: SNAPSHOT_SCHEME, snapshotId: await headerId(header), ...header, entities };
}

/** The exact bytes to store: canonical JSON, so the same snapshot always serialises the same way. */
export const serializeFarmSnapshot = (s: FarmSnapshot): string => canonicalJson(s);

export interface SnapshotCheck {
  ok: boolean;
  problems: string[];
}

/** Recomputes every entity hash, the order, the root and the id. Says nothing about on-chain anchoring. */
export async function verifyFarmSnapshot(s: FarmSnapshot): Promise<SnapshotCheck> {
  const problems: string[] = [];
  if (s.scheme !== SNAPSHOT_SCHEME) problems.push(`unknown scheme ${String(s.scheme)}`);
  if (s.entitySchemaVersion !== SNAPSHOT_ENTITY_SCHEMA_VERSION) problems.push(`unsupported entity schema version ${s.entitySchemaVersion}`);
  if (s.entities.length !== s.entityCount) problems.push("entityCount does not match the entities");
  if (problems.length) return { ok: false, problems };
  for (let i = 1; i < s.entities.length; i++) {
    if (compareEntities(s.entities[i - 1]!, s.entities[i]!) >= 0) {
      problems.push("entities are not in (type, id) order or repeat");
      break;
    }
  }
  for (const e of s.entities) {
    const problem = plainJsonProblem(e.data);
    if (problem) problems.push(`${e.type}/${e.id}: ${problem}`);
    else if ((await entityHash(e)) !== e.sha256) problems.push(`${e.type}/${e.id}: hash does not match its data`);
  }
  if (s.entities.length === 0 || s.entities.length > MAX_BATCH_LEAVES) problems.push("entity count out of range");
  else if ((await merkleRoot(await Promise.all(s.entities.map((e) => merkleLeaf(e.sha256))))) !== s.root) problems.push("root does not match the entity hashes");
  const id = await headerId({ farmId: s.farmId, takenAt: s.takenAt, entitySchemaVersion: s.entitySchemaVersion, entityCount: s.entityCount, root: s.root });
  if (id !== s.snapshotId) problems.push("snapshotId does not match the header");
  return { ok: problems.length === 0, problems };
}

/** Proof that one entity is in a snapshot, for disclosing it alone. Verify with `verifyMerkleInclusion`. */
export async function snapshotEntityProof(s: FarmSnapshot, type: SnapshotEntityType, id: string): Promise<{ entity: SnapshotEntity; proof: InclusionProof } | null> {
  const index = s.entities.findIndex((e) => e.type === type && e.id === id);
  if (index < 0) return null;
  const leaves = await Promise.all(s.entities.map((e) => merkleLeaf(e.sha256)));
  return { entity: s.entities[index]!, proof: { leaf: leaves[index]!, index, size: leaves.length, path: await merkleAuditPath(leaves, index), root: s.root } };
}

const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)]));

/** Shape check for a snapshot read back from storage; follow with `verifyFarmSnapshot`. */
export const farmSnapshotSchema = z
  .object({
    scheme: z.literal(SNAPSHOT_SCHEME),
    snapshotId: z.string().regex(/^[0-9a-f]{64}$/),
    farmId: z.string().regex(ID),
    takenAt: z.string().datetime(),
    entitySchemaVersion: z.number().int().min(1),
    entityCount: z.number().int().min(1).max(MAX_BATCH_LEAVES),
    root: z.string().regex(/^[0-9a-f]{64}$/),
    entities: z.array(
      z.object({ type: z.enum(SNAPSHOT_ENTITY_TYPES), id: z.string().regex(ID), data: z.record(jsonValue), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    ),
  })
  .strict();

/** Reads a stored snapshot back and verifies it end to end. */
export async function reconstructFarmSnapshot(json: string): Promise<{ snapshot: FarmSnapshot; check: SnapshotCheck }> {
  const snapshot = farmSnapshotSchema.parse(JSON.parse(json)) as FarmSnapshot;
  return { snapshot, check: await verifyFarmSnapshot(snapshot) };
}
