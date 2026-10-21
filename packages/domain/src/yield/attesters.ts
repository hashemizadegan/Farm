/**
 * Attester authorization: who an attester is, and whether an attestation may count as theirs.
 *
 * D-23 (attester identity requirements) is **open**; see docs/delivery/decision-brief-d23-attester-identity.md.
 * This module implements **Option B (a named entity with an approved key registry) as a provisional
 * default**, behind an interface so another identity model (A, C or D) can replace it without changing
 * Y3: attestations, method lists and quorum evaluation are untouched.
 *
 * Fail-closed: a registry is a record with a status. A real cycle uses only an `approved` registry, and
 * none exists until D-23 is approved, so real cycles cannot authorize anyone. Simulation cycles use a
 * `simulation` registry.
 *
 * Choices D-23 leaves open are required registry fields, never assumed:
 * - `revocationEffect` (brief, question 4): whether revoking a key voids attestations made before the
 *   revocation (`invalidates_all`) or only later ones (`from_revocation_time`).
 *
 * What it does not do: verify signatures (`assertAttestationAccepted` does), check that a recorded
 * attestation's audit event exists (the caller's store does), or decide independence between entities.
 */
import { type Attestation, type AttestationMethodList, KEY_SIGNATURE_ALGORITHMS, type KeySignatureAlgorithm, YieldAttestationError, assertKeySignaturePublicKey } from "./attestation";
import { isRfc3339WithOffset } from "./evidence";
import { type AttestationQuorum, type QuorumResult, evaluateAttestationQuorum } from "./quorum";
import { YIELD_RECORD_STATUSES, assertYieldRecordUsable, type YieldRecordStatus } from "./records";

// ── The swappable interface ────────────────────────────────────────────────────────────────────────

export type AttesterRefusal = "unknown_attester" | "attester_not_active" | "role_not_held" | "key_not_registered" | "key_registered_to_other_attester" | "key_not_valid_at_issue" | "key_revoked";

export type AttesterAuthorization = { authorized: true; entityId: string; keyId: string | null } | { authorized: false; reason: AttesterRefusal; detail: string };

/** Any identity model implements this. Quorum code depends only on it. */
export interface AttesterAuthorizer {
  /** Which identity model this is, e.g. `named_entity_key_registry`. */
  readonly model: string;
  /** Whether the attestation may count for its named attester in this cycle. Throws if the authorizer's record is not usable for the cycle. */
  authorize(cycle: { simulation: boolean }, attestation: Attestation): AttesterAuthorization;
}

export class AttesterAuthorizationError extends Error {
  constructor(
    readonly reason: AttesterRefusal | "invalid_registry",
    message: string,
  ) {
    super(message);
    this.name = "AttesterAuthorizationError";
  }
}

// ── Option B: named entity with an approved key registry (provisional, pending D-23) ──────────────

export const ATTESTER_REGISTRY_MODEL = "named_entity_key_registry";
export const ATTESTER_STATUSES = ["active", "suspended", "revoked"] as const;
export type AttesterStatus = (typeof ATTESTER_STATUSES)[number];
export const KEY_REVOCATION_EFFECTS = ["invalidates_all", "from_revocation_time"] as const;
export type KeyRevocationEffect = (typeof KEY_REVOCATION_EFFECTS)[number];

export interface RegisteredKey {
  keyId: string;
  algorithm: KeySignatureAlgorithm;
  publicKey: string;
  /** RFC 3339 with an offset. */
  validFrom: string;
  /** RFC 3339 with an offset, or null for open-ended. */
  validUntil: string | null;
  /** RFC 3339 with an offset, or null if not revoked. */
  revokedAt: string | null;
}

export interface AttesterEntity {
  /** The identifier attestations name in `attester`. */
  entityId: string;
  /** Roles this entity may attest in. */
  roles: string[];
  /** Evaluated as of this registry version: a suspended or revoked entity authorizes nothing. */
  status: AttesterStatus;
  keys: RegisteredKey[];
}

export interface AttesterRegistry {
  id: string;
  version: number;
  status: YieldRecordStatus;
  model: typeof ATTESTER_REGISTRY_MODEL;
  /** Pending D-23 (brief, question 4). Required; no default. */
  revocationEffect: KeyRevocationEffect;
  entities: AttesterEntity[];
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "" && v.trim() === v;
const keysOf = (o: object) => Object.keys(o);
const extraKeys = (path: string, o: object, allowed: string[]) => {
  const extra = keysOf(o).filter((k) => !allowed.includes(k));
  return extra.length ? [`${path} has unsupported keys: ${extra.sort().join(", ")}`] : [];
};

/** Every problem with a registry, or an empty list. One key may belong to one entity only. */
export function attesterRegistryProblems(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["a registry must be an object"];
  const o = v as Record<string, unknown>;
  const out = extraKeys("registry", o, ["id", "version", "status", "model", "revocationEffect", "entities"]);
  if (!nonEmpty(o.id)) out.push("id must be a non-empty string");
  if (!(typeof o.version === "number" && Number.isSafeInteger(o.version) && o.version >= 1)) out.push("version must be an integer ≥ 1");
  if (!(YIELD_RECORD_STATUSES as readonly unknown[]).includes(o.status)) out.push(`status must be one of ${YIELD_RECORD_STATUSES.join(", ")}`);
  if (o.model !== ATTESTER_REGISTRY_MODEL) out.push(`model must be ${ATTESTER_REGISTRY_MODEL}`);
  if (!(KEY_REVOCATION_EFFECTS as readonly unknown[]).includes(o.revocationEffect)) out.push(`revocationEffect must be one of ${KEY_REVOCATION_EFFECTS.join(", ")}`);
  if (!Array.isArray(o.entities)) return [...out, "entities must be a list"];

  const entityIds = new Set<string>();
  const keyIds = new Set<string>();
  const keyOwner = new Map<string, string>();
  o.entities.forEach((e: Record<string, unknown>, i: number) => {
    const p = `entities[${i}]`;
    if (!e || typeof e !== "object") return out.push(`${p} must be an object`);
    out.push(...extraKeys(p, e, ["entityId", "roles", "status", "keys"]));
    if (!nonEmpty(e.entityId)) out.push(`${p}.entityId must be a non-empty string`);
    else if (entityIds.has(e.entityId)) out.push(`${p}.entityId repeats ${e.entityId}`);
    else entityIds.add(e.entityId);
    if (!Array.isArray(e.roles) || e.roles.length === 0 || !e.roles.every(nonEmpty) || new Set(e.roles).size !== e.roles.length) out.push(`${p}.roles must be a non-empty list of distinct roles`);
    if (!(ATTESTER_STATUSES as readonly unknown[]).includes(e.status)) out.push(`${p}.status must be one of ${ATTESTER_STATUSES.join(", ")}`);
    if (!Array.isArray(e.keys)) return out.push(`${p}.keys must be a list`);
    e.keys.forEach((k: Record<string, unknown>, j: number) => {
      const kp = `${p}.keys[${j}]`;
      if (!k || typeof k !== "object") return out.push(`${kp} must be an object`);
      out.push(...extraKeys(kp, k, ["keyId", "algorithm", "publicKey", "validFrom", "validUntil", "revokedAt"]));
      if (!nonEmpty(k.keyId)) out.push(`${kp}.keyId must be a non-empty string`);
      else if (keyIds.has(k.keyId)) out.push(`${kp}.keyId repeats ${k.keyId}`);
      else keyIds.add(k.keyId);
      if (!(KEY_SIGNATURE_ALGORITHMS as readonly unknown[]).includes(k.algorithm)) out.push(`${kp}.algorithm must be one of ${KEY_SIGNATURE_ALGORITHMS.join(", ")}`);
      else {
        try {
          assertKeySignaturePublicKey(k.algorithm as KeySignatureAlgorithm, k.publicKey as string);
          const fingerprint = `${String(k.algorithm)}:${String(k.publicKey)}`;
          const owner = keyOwner.get(fingerprint);
          if (owner !== undefined && owner !== e.entityId) out.push(`${kp} is already registered to ${owner}: a key belongs to one entity`);
          else if (owner !== undefined) out.push(`${kp} repeats a key of the same entity`);
          else keyOwner.set(fingerprint, String(e.entityId));
        } catch (err) {
          out.push(`${kp}.publicKey: ${(err as Error).message}`);
        }
      }
      if (!isRfc3339WithOffset(k.validFrom)) out.push(`${kp}.validFrom must be RFC 3339 with an offset`);
      for (const f of ["validUntil", "revokedAt"] as const) {
        if (!Object.prototype.hasOwnProperty.call(k, f)) out.push(`${kp}.${f} must be given (null for none)`);
        else if (k[f] !== null && !isRfc3339WithOffset(k[f])) out.push(`${kp}.${f} must be RFC 3339 with an offset or null`);
      }
      if (isRfc3339WithOffset(k.validFrom) && isRfc3339WithOffset(k.validUntil) && Date.parse(k.validUntil) <= Date.parse(k.validFrom)) out.push(`${kp}.validUntil must be after validFrom`);
      if (isRfc3339WithOffset(k.validFrom) && isRfc3339WithOffset(k.revokedAt) && Date.parse(k.revokedAt) < Date.parse(k.validFrom)) out.push(`${kp}.revokedAt must not be before validFrom`);
    });
  });
  return out;
}

/** An authorizer over a validated Option B registry. Throws `invalid_registry` for an invalid one. */
export function registryAuthorizer(registry: AttesterRegistry): AttesterAuthorizer {
  const problems = attesterRegistryProblems(registry);
  if (problems.length) throw new AttesterAuthorizationError("invalid_registry", `invalid attester registry: ${problems.join("; ")}`);
  const entities = new Map(registry.entities.map((e) => [e.entityId, e]));
  const keyOwner = new Map<string, { entity: AttesterEntity; key: RegisteredKey }>();
  for (const e of registry.entities) for (const k of e.keys) keyOwner.set(`${k.algorithm}:${k.publicKey}`, { entity: e, key: k });
  const refuse = (reason: AttesterRefusal, detail: string): AttesterAuthorization => ({ authorized: false, reason, detail });

  return {
    model: ATTESTER_REGISTRY_MODEL,
    authorize(cycle, a) {
      assertYieldRecordUsable(cycle, { status: registry.status, kind: "attester registry" });
      const entity = entities.get(a.attester);
      if (!entity) return refuse("unknown_attester", `${a.attester} is not a registered attester`);
      if (entity.status !== "active") return refuse("attester_not_active", `${a.attester} is ${entity.status}`);
      if (!entity.roles.includes(a.role)) return refuse("role_not_held", `${a.attester} does not hold the role ${a.role}`);
      if (a.proof.method !== "key_signature") return { authorized: true, entityId: entity.entityId, keyId: null };

      const found = keyOwner.get(`${a.proof.algorithm}:${a.proof.publicKey}`);
      if (!found) return refuse("key_not_registered", "the signing key is not registered");
      if (found.entity.entityId !== entity.entityId) return refuse("key_registered_to_other_attester", `the signing key belongs to ${found.entity.entityId}, not ${a.attester}`);
      const at = Date.parse(a.issuedAt);
      const k = found.key;
      if (at < Date.parse(k.validFrom) || (k.validUntil !== null && at >= Date.parse(k.validUntil))) return refuse("key_not_valid_at_issue", `key ${k.keyId} was not valid at ${a.issuedAt}`);
      if (k.revokedAt !== null && (registry.revocationEffect === "invalidates_all" || at >= Date.parse(k.revokedAt))) return refuse("key_revoked", `key ${k.keyId} was revoked at ${k.revokedAt}`);
      return { authorized: true, entityId: entity.entityId, keyId: k.keyId };
    },
  };
}

/**
 * Evaluates a quorum counting only authorized attestations: every attestation must be authorized for its
 * named attester (otherwise the whole evaluation fails, nothing is skipped), then Y3's quorum rules apply.
 * Because an authorized attestation's attester is a registered entity, quorum counts entities, not keys.
 */
export async function evaluateAuthorizedQuorum(
  cycle: { simulation: boolean; assetClass: string },
  quorum: AttestationQuorum,
  methods: AttestationMethodList,
  authorizer: AttesterAuthorizer,
  subjectHashes: readonly string[],
  attestations: readonly Attestation[],
): Promise<QuorumResult> {
  if (!Array.isArray(attestations)) throw new YieldAttestationError("invalid_attestation", "attestations must be a list");
  for (const a of attestations) {
    const r = authorizer.authorize(cycle, a);
    if (!r.authorized) throw new AttesterAuthorizationError(r.reason, r.detail);
    if (r.entityId !== a.attester) throw new AttesterAuthorizationError("unknown_attester", `the authorizer mapped ${a.attester} to ${r.entityId}`);
  }
  return evaluateAttestationQuorum(cycle, quorum, methods, subjectHashes, attestations);
}

/**
 * A simulation-status registry (pending D-23; Option B provisional). The revocation effect defaults to
 * the conservative `invalidates_all` for simulation only. A real cycle refuses this record.
 */
export function simulationAttesterRegistry(entities: AttesterEntity[], revocationEffect: KeyRevocationEffect = "invalidates_all"): AttesterRegistry {
  return { id: "simulation-attester-registry", version: 1, status: "simulation", model: ATTESTER_REGISTRY_MODEL, revocationEffect, entities };
}
