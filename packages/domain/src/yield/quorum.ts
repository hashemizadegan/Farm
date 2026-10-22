/**
 * Attestation quorum as data (Real Yield Distribution plan, revision 4, §5.4 and §12.1: "Y3/Y9 implement
 * the methods as types and the quorum as data"). Which roles, how many attesters, and for which asset
 * class are decided by D-23; this module holds no values. A real cycle uses only an `approved` quorum
 * record, a simulation cycle only a `simulation` one.
 *
 * Evaluation counts **distinct attesters** per role whose accepted attestation covers every required
 * subject hash. Two choices the plan leaves open are explicit inputs, never assumed:
 * - `attesterMayFillSeveralRoles` (in the record): whether one attester may count towards more than one role;
 * - which attestations are still in effect: the caller resolves revocations and passes only effective,
 *   non-revoking attestations (who may revoke whose attestation is not decided here). A revoking
 *   attestation passed in is refused, not silently skipped.
 */
import { type Attestation, type AttestationMethodList, YieldAttestationError, assertAttestationAccepted } from "./attestation";
import { isSha256Hex } from "../twin/commitments";
import { YIELD_RECORD_STATUSES, assertYieldRecordUsable, type YieldRecordStatus } from "./records";

export interface AttestationQuorumRule {
  role: string;
  minimumAttesters: number;
}

export interface AttestationQuorum {
  id: string;
  version: number;
  status: YieldRecordStatus;
  /** The asset class the quorum applies to (D-20, D-23). */
  assetClass: string;
  rules: AttestationQuorumRule[];
  /** Whether one attester may count towards several roles. Required; there is no default. */
  attesterMayFillSeveralRoles: boolean;
}

export interface QuorumRoleResult {
  role: string;
  required: number;
  /** Distinct attesters whose effective attestation in this role covers every subject hash, sorted. */
  eligible: string[];
  /** Attesters counted for this role, sorted: all eligible ones, or the role's share of the assignment. */
  counted: string[];
  met: boolean;
}

export interface QuorumResult {
  met: boolean;
  roles: QuorumRoleResult[];
}

const nonEmpty = (v: unknown) => typeof v === "string" && v.trim() !== "" && v.trim() === v;

/** Every problem with a quorum record, or an empty list. */
export function attestationQuorumProblems(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["a quorum must be an object"];
  const o = v as Record<string, unknown>;
  const out: string[] = [];
  const allowed = ["id", "version", "status", "assetClass", "rules", "attesterMayFillSeveralRoles"];
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) out.push(`quorum has unsupported keys: ${extra.sort().join(", ")}`);
  if (!nonEmpty(o.id)) out.push("id must be a non-empty string");
  if (!(typeof o.version === "number" && Number.isSafeInteger(o.version) && o.version >= 1)) out.push("version must be an integer ≥ 1");
  if (!(YIELD_RECORD_STATUSES as readonly unknown[]).includes(o.status)) out.push(`status must be one of ${YIELD_RECORD_STATUSES.join(", ")}`);
  if (!nonEmpty(o.assetClass)) out.push("assetClass must be a non-empty string");
  if (typeof o.attesterMayFillSeveralRoles !== "boolean") out.push("attesterMayFillSeveralRoles must be true or false");
  if (!Array.isArray(o.rules) || o.rules.length === 0) out.push("rules must be a non-empty list (a quorum must require something)");
  else {
    const roles = new Set<string>();
    o.rules.forEach((r: Record<string, unknown>, i: number) => {
      if (!r || typeof r !== "object") return out.push(`rules[${i}] must be an object`);
      const ex = Object.keys(r).filter((k) => k !== "role" && k !== "minimumAttesters");
      if (ex.length) out.push(`rules[${i}] has unsupported keys: ${ex.sort().join(", ")}`);
      if (!nonEmpty(r.role)) out.push(`rules[${i}].role must be a non-empty string`);
      else if (roles.has(r.role as string)) out.push(`rules[${i}].role repeats ${String(r.role)}`);
      else roles.add(r.role as string);
      if (!(typeof r.minimumAttesters === "number" && Number.isSafeInteger(r.minimumAttesters) && r.minimumAttesters >= 1)) out.push(`rules[${i}].minimumAttesters must be an integer ≥ 1`);
    });
  }
  return out;
}

/**
 * Evaluates the quorum for `subjectHashes` (e.g. the artifact-set hashes). Every attestation passed in is
 * checked with `assertAttestationAccepted` (method list and, for key signatures, the signature); any that
 * fails makes the whole evaluation fail rather than being ignored.
 */
export async function evaluateAttestationQuorum(
  cycle: { simulation: boolean; assetClass: string },
  quorum: AttestationQuorum,
  methods: AttestationMethodList,
  subjectHashes: readonly string[],
  attestations: readonly Attestation[],
): Promise<QuorumResult> {
  const problems = attestationQuorumProblems(quorum);
  if (problems.length) throw new YieldAttestationError("invalid_attestation", `invalid quorum: ${problems.join("; ")}`);
  assertYieldRecordUsable(cycle, { status: quorum.status, kind: "attestation quorum" });
  if (!nonEmpty(cycle.assetClass) || cycle.assetClass !== quorum.assetClass) throw new YieldAttestationError("invalid_attestation", `the quorum is for asset class ${quorum.assetClass}, not ${String(cycle.assetClass)}`);
  if (!Array.isArray(subjectHashes) || subjectHashes.length === 0 || !subjectHashes.every(isSha256Hex) || new Set(subjectHashes).size !== subjectHashes.length)
    throw new YieldAttestationError("invalid_attestation", "subject hashes must be a non-empty list of distinct SHA-256 hashes");
  if (!Array.isArray(attestations)) throw new YieldAttestationError("invalid_attestation", "attestations must be a list");

  for (const a of attestations) {
    await assertAttestationAccepted(cycle, methods, a);
    if (a.revokes !== null) throw new YieldAttestationError("invalid_attestation", "pass only effective attestations: revocations are resolved by the caller");
  }

  const covering = attestations.filter((a) => subjectHashes.every((h) => a.subjectHashes.includes(h)));
  const eligible = quorum.rules.map((rule) => [...new Set(covering.filter((a) => a.role === rule.role).map((a) => a.attester))].sort());

  if (quorum.attesterMayFillSeveralRoles) {
    const roles = quorum.rules.map((rule, i) => ({ role: rule.role, required: rule.minimumAttesters, eligible: eligible[i]!, counted: eligible[i]!, met: eligible[i]!.length >= rule.minimumAttesters }));
    return { met: roles.every((r) => r.met), roles };
  }

  // One attester per role slot: a maximum bipartite matching (augmenting paths), so the answer does not
  // depend on the order in which attesters are tried. Slots and candidates are visited in a fixed order
  // (rule order, then sorted attester ids), so the assignment reported is deterministic too.
  // Short-circuit before allocating slots (minimumAttesters comes from data and is not bounded): if a role
  // has fewer eligible attesters than it needs, or the roles need more attesters than exist, it is unmet.
  const distinct = new Set(eligible.flat()).size;
  const needed = quorum.rules.reduce((n, r) => n + r.minimumAttesters, 0);
  if (needed > distinct || quorum.rules.some((r, i) => r.minimumAttesters > eligible[i]!.length)) {
    const roles = quorum.rules.map((rule, i) => ({ role: rule.role, required: rule.minimumAttesters, eligible: eligible[i]!, counted: [] as string[], met: false }));
    return { met: false, roles };
  }
  const slots = quorum.rules.flatMap((rule, i) => Array.from({ length: rule.minimumAttesters }, () => i));
  const slotOf = new Map<string, number>();
  const assign = (slot: number, seen: Set<string>): boolean => {
    for (const attester of eligible[slots[slot]!]!) {
      if (seen.has(attester)) continue;
      seen.add(attester);
      const held = slotOf.get(attester);
      if (held === undefined || assign(held, seen)) {
        slotOf.set(attester, slot);
        return true;
      }
    }
    return false;
  };
  let filled = 0;
  slots.forEach((_, slot) => {
    if (assign(slot, new Set())) filled += 1;
  });
  const roles = quorum.rules.map((rule, i) => {
    const counted = [...slotOf.entries()].filter(([, slot]) => slots[slot] === i).map(([a]) => a).sort();
    return { role: rule.role, required: rule.minimumAttesters, eligible: eligible[i]!, counted, met: counted.length >= rule.minimumAttesters };
  });
  return { met: filled === slots.length, roles };
}
