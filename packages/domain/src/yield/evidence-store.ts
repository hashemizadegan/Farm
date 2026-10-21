/**
 * Evidence storage model (Real Yield Distribution plan, revision 4, Y4 and §5). Pure domain model: no
 * database, no network. Evidence bytes go through the content-store port of PR #41
 * (`twin/content-store.ts`), whose production adapter would be private object storage (PR #43). This
 * module adds the yield-specific rules on top:
 *
 * - **Append-only ledger.** Evidence is registered into an immutable ledger value; every operation
 *   returns a new ledger whose entries extend the old ones. Nothing is edited or deleted. A correction is
 *   a new, superseding item (plan §5.2).
 * - **Commitment freezes a cycle version.** Committing produces the canonical manifest and its SHA-256
 *   (Y3). After that, the cycle version accepts no more evidence; a change needs a new cycle version.
 * - **Storage and retention are D-24.** A registration needs a storage policy record usable for the
 *   cycle: `approved` for a real cycle (none exists until D-24, so real evidence registration fails
 *   closed, as the plan requires), `simulation` for a simulation cycle. Public storage (IPFS, Arweave) is
 *   not offered: D-24 must be approved before any public-storage integration is built.
 */
import { canonicalJson } from "../harvest";
import { checkStorageRef } from "../twin/commitments";
import type { ContentStore } from "../twin/content-store";
import { assertExactKeys } from "./amounts";
import { type EvidenceItem, type EvidenceManifest, assertEvidenceBytes, assertEvidenceItem, buildEvidenceManifest, compareEvidenceItems, evidenceManifestHash } from "./evidence";
import { YIELD_RECORD_STATUSES, assertYieldRecordUsable, type YieldRecordStatus } from "./records";

/** Storage kinds that may be built before D-24. Public options are deliberately absent. */
export const EVIDENCE_STORAGE_KINDS = ["private_object_storage", "in_memory_test"] as const;
export type EvidenceStorageKind = (typeof EVIDENCE_STORAGE_KINDS)[number];

/** D-24 record: where evidence bytes live and which retention classes exist. */
export interface EvidenceStoragePolicy {
  id: string;
  version: number;
  status: YieldRecordStatus;
  storageKind: EvidenceStorageKind;
  /** Retention classes an item may name (`EvidenceItem.retentionClassId`). Pending D-24. */
  retentionClassIds: readonly string[];
}

/** Temporary defaults for **simulation cycles only**; a real cycle refuses this record (pending D-24). */
export const SIMULATION_EVIDENCE_STORAGE_POLICY: EvidenceStoragePolicy = Object.freeze({
  id: "simulation-evidence-storage",
  version: 1,
  status: "simulation",
  storageKind: "in_memory_test", // pending D-24
  retentionClassIds: Object.freeze(["simulation-retention"]), // pending D-24
});

export type EvidenceLedgerEntry =
  | { seq: number; kind: "registered"; cycleId: string; cycleVersion: number; policyId: string; policyVersion: number; storageRef: string; item: EvidenceItem }
  | { seq: number; kind: "committed"; cycleId: string; cycleVersion: number; manifestSha256: string; itemCount: number };

export interface EvidenceLedger {
  readonly entries: readonly EvidenceLedgerEntry[];
}

export type EvidenceStoreErrorCode = "invalid_policy" | "storage_ref" | "retention_class" | "conflict" | "committed" | "supersession" | "missing_bytes" | "ledger_corrupt";

export class EvidenceStoreError extends Error {
  constructor(
    readonly code: EvidenceStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceStoreError";
  }
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "" && v.trim() === v;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

/** Every problem with a storage policy record, or an empty list. */
export function evidenceStoragePolicyProblems(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["a storage policy must be an object"];
  const o = v as Record<string, unknown>;
  const out: string[] = [];
  const extra = Object.keys(o).filter((k) => !["id", "version", "status", "storageKind", "retentionClassIds"].includes(k));
  if (extra.length) out.push(`storage policy has unsupported keys: ${extra.sort().join(", ")}`);
  if (!nonEmpty(o.id)) out.push("id must be a non-empty string");
  if (!(typeof o.version === "number" && Number.isSafeInteger(o.version) && o.version >= 1)) out.push("version must be an integer ≥ 1");
  if (!(YIELD_RECORD_STATUSES as readonly unknown[]).includes(o.status)) out.push(`status must be one of ${YIELD_RECORD_STATUSES.join(", ")}`);
  if (!(EVIDENCE_STORAGE_KINDS as readonly unknown[]).includes(o.storageKind)) out.push(`storageKind must be one of ${EVIDENCE_STORAGE_KINDS.join(", ")} (public storage needs D-24)`);
  const r = o.retentionClassIds;
  if (!Array.isArray(r) || r.length === 0 || !r.every(nonEmpty) || new Set(r).size !== r.length) out.push("retentionClassIds must be a non-empty list of distinct ids");
  return out;
}

/** A new, empty ledger. */
export function emptyEvidenceLedger(): EvidenceLedger {
  return deepFreeze({ entries: [] });
}

const sameCycle = (e: EvidenceLedgerEntry, id: string, version: number) => e.cycleId === id && e.cycleVersion === version;

/** The items registered for a cycle version, in canonical manifest order. */
export function evidenceItemsFor(ledger: EvidenceLedger, cycleId: string, cycleVersion: number): EvidenceItem[] {
  return ledger.entries
    .filter((e): e is Extract<EvidenceLedgerEntry, { kind: "registered" }> => e.kind === "registered" && sameCycle(e, cycleId, cycleVersion))
    .map((e) => ({ ...e.item }))
    .sort(compareEvidenceItems);
}

/** Whether a cycle version has been committed. */
export function isEvidenceCommitted(ledger: EvidenceLedger, cycleId: string, cycleVersion: number): boolean {
  return ledger.entries.some((e) => e.kind === "committed" && sameCycle(e, cycleId, cycleVersion));
}

/**
 * Registers an item for a cycle version and returns the new ledger. Re-registering an identical item is a
 * no-op (the same ledger is returned); the same type and hash with different metadata is a conflict.
 */
export function registerEvidence(
  ledger: EvidenceLedger,
  input: { cycle: { id: string; version: number; simulation: boolean }; policy: EvidenceStoragePolicy; item: EvidenceItem; storageRef: string },
): EvidenceLedger {
  assertExactKeys("registration", input, ["cycle", "policy", "item", "storageRef"]);
  const { cycle, policy, item, storageRef } = input;
  assertExactKeys("cycle", cycle as unknown, ["id", "version", "simulation"]);
  if (!nonEmpty(cycle.id) || !Number.isSafeInteger(cycle.version) || cycle.version < 1 || typeof cycle.simulation !== "boolean") throw new EvidenceStoreError("invalid_policy", "the cycle needs an id, a version ≥ 1 and an explicit simulation flag");
  const problems = evidenceStoragePolicyProblems(policy);
  if (problems.length) throw new EvidenceStoreError("invalid_policy", `invalid storage policy: ${problems.join("; ")}`);
  assertYieldRecordUsable(cycle, { status: policy.status, kind: "evidence storage policy" });
  assertEvidenceItem(item);
  if (!policy.retentionClassIds.includes(item.retentionClassId)) throw new EvidenceStoreError("retention_class", `retention class ${item.retentionClassId} is not in storage policy ${policy.id}`);

  const ref = checkStorageRef(storageRef, item.contentSha256);
  if ("error" in ref) throw new EvidenceStoreError("storage_ref", ref.error);
  const allowed = policy.storageKind === "private_object_storage" ? ["hash", "object_storage"] : ["hash"];
  if (!allowed.includes(ref.kind)) throw new EvidenceStoreError("storage_ref", `a ${ref.kind} reference is not allowed for ${policy.storageKind}`);

  if (isEvidenceCommitted(ledger, cycle.id, cycle.version)) throw new EvidenceStoreError("committed", `cycle ${cycle.id} version ${cycle.version} is committed; evidence needs a new cycle version`);

  const registered = ledger.entries.filter((e): e is Extract<EvidenceLedgerEntry, { kind: "registered" }> => e.kind === "registered" && e.cycleId === cycle.id);
  const existing = registered.find((e) => e.cycleVersion === cycle.version && compareEvidenceItems(e.item, item) === 0);
  if (existing) {
    const same = canonicalJson(existing.item) === canonicalJson(item) && existing.storageRef === storageRef;
    if (same) return ledger;
    throw new EvidenceStoreError("conflict", `evidence ${item.type} ${item.contentSha256} is already registered with different metadata`);
  }
  if (item.supersedes !== null) {
    if (!registered.some((e) => e.item.contentSha256 === item.supersedes)) throw new EvidenceStoreError("supersession", `the superseded item ${item.supersedes} is not registered for cycle ${cycle.id}`);
    const other = registered.find((e) => e.item.supersedes === item.supersedes && e.item.contentSha256 !== item.contentSha256);
    if (other) throw new EvidenceStoreError("supersession", `item ${item.supersedes} is already superseded by ${other.item.contentSha256}`);
  }

  const entry: EvidenceLedgerEntry = { seq: ledger.entries.length + 1, kind: "registered", cycleId: cycle.id, cycleVersion: cycle.version, policyId: policy.id, policyVersion: policy.version, storageRef, item: { ...item } };
  return deepFreeze({ entries: [...ledger.entries, entry] });
}

/**
 * Commits a cycle version's evidence: builds the canonical manifest of every registered item (superseded
 * items included; Track 2 refuses to aggregate them) and records its SHA-256. A cycle version commits once.
 */
export async function commitEvidence(ledger: EvidenceLedger, cycle: { id: string; version: number }): Promise<{ ledger: EvidenceLedger; manifest: EvidenceManifest; manifestSha256: string }> {
  if (isEvidenceCommitted(ledger, cycle.id, cycle.version)) throw new EvidenceStoreError("committed", `cycle ${cycle.id} version ${cycle.version} is already committed`);
  const manifest = buildEvidenceManifest({ cycleId: cycle.id, cycleVersion: cycle.version, items: evidenceItemsFor(ledger, cycle.id, cycle.version) });
  const manifestSha256 = await evidenceManifestHash(manifest);
  const entry: EvidenceLedgerEntry = { seq: ledger.entries.length + 1, kind: "committed", cycleId: cycle.id, cycleVersion: cycle.version, manifestSha256, itemCount: manifest.items.length };
  return { ledger: deepFreeze({ entries: [...ledger.entries, entry] }), manifest, manifestSha256 };
}

/** Whether `next` only appends to `prev` (every earlier entry unchanged, in place). */
export function isAppendOnlyExtension(prev: EvidenceLedger, next: EvidenceLedger): boolean {
  if (next.entries.length < prev.entries.length) return false;
  const enc = (e: EvidenceLedgerEntry) => canonicalJson(e);
  return prev.entries.every((e, i) => enc(e) === enc(next.entries[i]!));
}

/**
 * Checks a ledger's invariants (e.g. one loaded from storage): consecutive sequence numbers, valid
 * items, no registration after its cycle version's commitment, one commitment per cycle version, and
 * every commitment matching the manifest of the items registered before it.
 */
export async function assertEvidenceLedger(ledger: EvidenceLedger): Promise<void> {
  const committed = new Set<string>();
  for (const [i, e] of ledger.entries.entries()) {
    if (e.seq !== i + 1) throw new EvidenceStoreError("ledger_corrupt", `entry ${i} has sequence ${e.seq}`);
    const key = `${e.cycleId}\u0000${e.cycleVersion}`;
    if (e.kind === "registered") {
      assertEvidenceItem(e.item);
      if (committed.has(key)) throw new EvidenceStoreError("ledger_corrupt", `entry ${e.seq} registers evidence after its cycle version was committed`);
    } else {
      if (committed.has(key)) throw new EvidenceStoreError("ledger_corrupt", `entry ${e.seq} commits a cycle version twice`);
      const before = { entries: ledger.entries.slice(0, i) };
      const items = evidenceItemsFor(before, e.cycleId, e.cycleVersion);
      const hash = await evidenceManifestHash(buildEvidenceManifest({ cycleId: e.cycleId, cycleVersion: e.cycleVersion, items }));
      if (hash !== e.manifestSha256 || items.length !== e.itemCount) throw new EvidenceStoreError("ledger_corrupt", `entry ${e.seq} does not match the evidence registered before it`);
      committed.add(key);
    }
  }
}

/** Stores an item's exact bytes through the content-store port and returns the `sha256:` reference. */
export async function storeEvidenceBytes(store: ContentStore, item: EvidenceItem, bytes: Uint8Array): Promise<string> {
  await assertEvidenceBytes(item, bytes);
  const ref = await store.put(bytes, item.mediaType);
  if (ref.sha256 !== item.contentSha256 || ref.size !== item.byteSize) throw new EvidenceStoreError("storage_ref", "the store returned a reference that does not match the item");
  return ref.ref;
}

/** Reads an item's bytes back and checks them against the item (size and SHA-256). */
export async function readEvidenceBytes(store: ContentStore, item: EvidenceItem): Promise<Uint8Array> {
  const bytes = await store.get(item.contentSha256);
  if (!bytes) throw new EvidenceStoreError("missing_bytes", `no bytes stored for ${item.contentSha256}`);
  await assertEvidenceBytes(item, bytes);
  return bytes;
}
