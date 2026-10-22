/**
 * The simulation calculation dossier: everything the simulation cycle pipeline (`calculateSimulationCycle`) needs
 * that the platform's yield tables do not hold, in one content-addressed, **simulation-only** document per cycle.
 *
 * Why it exists (line join, 2026-10-22): the database records what was locked (cycle parameters, input lines,
 * evidence hashes, the ownership index). The pipeline also needs typed records with no defaults: the calculation
 * policy, the settlement rate, the distribution policy and ledger, each evidence item's full metadata, the
 * simulation payout addresses and the snapshot observation time. These come from the dossier and are **checked
 * against the database** by the engine (policy hash, entitlement, currency, settlement, every line and every
 * evidence hash); any difference refuses the calculation.
 *
 * Fail closed: every record in the dossier must be simulation-labelled (a real cycle can never use one), nothing
 * is filled in, and a malformed dossier is refused with a stable code.
 *
 * Bigints: the canonical form writes them as decimal strings (`toCanonicalValue`); parsing turns the fields named
 * in DOSSIER_BIGINT_KEYS back into bigints (and only those).
 */
import { assertExactKeys, YieldAmountError } from "./amounts";
import { EVIDENCE_LINE_CATEGORIES, type EvidenceLine } from "./aggregation";
import { canonicalYieldArtifact, yieldArtifactHash } from "./artifact";
import { type DistributionLedger, type DistributionPolicy, distributionPolicyProblems } from "./distribution";
import { type EvidenceItem, evidenceItemProblems, isRfc3339WithOffset } from "./evidence";
import { type RationalRate, assertRationalRate } from "./fx";
import { type YieldCalculationPolicy, yieldPolicyProblems } from "./policy";

export const SIMULATION_DOSSIER_SCHEME = "metafarm-yield-simulation-dossier/1";

export interface SimulationDossier {
  scheme: typeof SIMULATION_DOSSIER_SCHEME;
  /** The asset class the cycle is calculated under (plan §1.1; real classes need D-20). */
  assetClass: string;
  /** Status `simulation`. Its hash (`yieldArtifactHash`) must equal the cycle's locked policy hash. */
  calculationPolicy: YieldCalculationPolicy;
  /** The single conversion from the accounting currency into settlement base units (D-3, D-4). */
  settlementRate: RationalRate;
  /** Status `simulation`. */
  distributionPolicy: DistributionPolicy;
  /** What the previous cycle carried; explicit, empty when nothing is carried. */
  distributionLedger: DistributionLedger;
  /** Accounting minor units. */
  lossCarriedForward: bigint;
  /** Accounting minor units. */
  approvedReserveReleases: bigint;
  /** Full metadata of every evidence item the cycle's input lines point at; nothing else. */
  evidence: EvidenceItem[];
  /** One line per locked input line (`lineId` = `<sourceKind>:<sourceRef>`), same amount, currency and evidence. */
  lines: EvidenceLine[];
  /** Simulation payout address (base58 or 64 hex) per party in the ownership input, or null (withheld). */
  payoutAddresses: Record<string, string | null>;
  /** When the ownership point (the window's end slot) is taken to be observed (RFC 3339 with offset). */
  ownershipObservedAt: string;
}

export type SimulationDossierErrorCode = "invalid_dossier" | "not_simulation";

export class SimulationDossierError extends Error {
  constructor(
    readonly code: SimulationDossierErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SimulationDossierError";
  }
}

const KEYS = [
  "scheme",
  "assetClass",
  "calculationPolicy",
  "settlementRate",
  "distributionPolicy",
  "distributionLedger",
  "lossCarriedForward",
  "approvedReserveReleases",
  "evidence",
  "lines",
  "payoutAddresses",
  "ownershipObservedAt",
] as const;

/** Field names whose values are bigints in the records a dossier holds. */
export const DOSSIER_BIGINT_KEYS: ReadonlySet<string> = new Set([
  "basisPoints",
  "minimum",
  "maximum",
  "amount",
  "fromNetRevenue",
  "capBasisPointsOfNetRevenue",
  "maintenanceBasisPoints",
  "maintenanceCap",
  "riskBasisPoints",
  "riskCap",
  "num",
  "den",
  "dustThreshold",
  "carriedRemainder",
  "lossCarriedForward",
  "approvedReserveReleases",
]);

function revive(v: unknown, key: string | null): unknown {
  if (Array.isArray(v)) return v.map((x) => revive(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x, k)]));
  if (key !== null && DOSSIER_BIGINT_KEYS.has(key)) {
    if (typeof v === "bigint") return v;
    if (typeof v === "string" && /^-?\d{1,78}$/.test(v)) return BigInt(v);
  }
  return v;
}

const fail = (message: string): never => {
  throw new SimulationDossierError("invalid_dossier", message);
};

/**
 * Parses and checks a dossier (canonical JSON text, or an object with bigints or decimal strings). Returns a frozen
 * dossier; refuses anything not simulation-labelled, malformed or incomplete.
 */
export function parseSimulationDossier(input: string | unknown): SimulationDossier {
  let raw: unknown;
  try {
    raw = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    return fail("the dossier is not JSON");
  }
  const d = revive(raw, null) as Record<string, unknown>;
  try {
    assertExactKeys("dossier", d, KEYS);
  } catch (e) {
    fail((e as Error).message);
  }
  for (const k of KEYS) if (!(k in d)) fail(`the dossier has no ${k}`);
  if (d.scheme !== SIMULATION_DOSSIER_SCHEME) fail(`unknown dossier scheme ${String(d.scheme)}`);
  if (typeof d.assetClass !== "string" || d.assetClass.trim() === "") fail("assetClass must be a non-empty string");

  const policyProblems = yieldPolicyProblems(d.calculationPolicy);
  if (policyProblems.length) fail(`calculation policy: ${policyProblems.join("; ")}`);
  const policy = d.calculationPolicy as YieldCalculationPolicy;
  if (policy.status !== "simulation") throw new SimulationDossierError("not_simulation", `the calculation policy is ${policy.status}, not simulation`);

  try {
    assertRationalRate(d.settlementRate as RationalRate);
  } catch (e) {
    fail(`settlement rate: ${(e as Error).message}`);
  }
  const dp = distributionPolicyProblems(d.distributionPolicy);
  if (dp.length) fail(`distribution policy: ${dp.join("; ")}`);
  if ((d.distributionPolicy as DistributionPolicy).status !== "simulation") throw new SimulationDossierError("not_simulation", "the distribution policy is not a simulation record");

  const ledger = d.distributionLedger as DistributionLedger;
  try {
    assertExactKeys("distribution ledger", ledger, ["carriedRemainder", "deferred"]);
  } catch (e) {
    fail((e as Error).message);
  }
  if (typeof ledger.carriedRemainder !== "bigint" || ledger.carriedRemainder < 0n || !Array.isArray(ledger.deferred)) fail("the distribution ledger needs a carried remainder ≥ 0 and a deferred list");
  for (const k of ["lossCarriedForward", "approvedReserveReleases"] as const) if (typeof d[k] !== "bigint" || (d[k] as bigint) < 0n) fail(`${k} must be a non-negative integer`);

  if (!Array.isArray(d.evidence) || d.evidence.length === 0) fail("the dossier lists no evidence");
  for (const [i, item] of (d.evidence as unknown[]).entries()) {
    const p = evidenceItemProblems(item);
    if (p.length) fail(`evidence[${i}]: ${p.join("; ")}`);
  }
  if (!Array.isArray(d.lines) || d.lines.length === 0) fail("the dossier lists no lines");
  for (const [i, l] of (d.lines as Record<string, unknown>[]).entries()) {
    try {
      assertExactKeys(`lines[${i}]`, l, ["lineId", "evidenceSha256", "category", "amount", "currency", "completeness", "rate"]);
    } catch (e) {
      fail((e as Error).message);
    }
    if (!(EVIDENCE_LINE_CATEGORIES as readonly unknown[]).includes(l.category)) fail(`lines[${i}] has an unknown category`);
  }
  const pa = d.payoutAddresses;
  if (!pa || typeof pa !== "object" || Array.isArray(pa)) fail("payoutAddresses must be an object");
  for (const [party, addr] of Object.entries(pa as object)) if (addr !== null && typeof addr !== "string") fail(`payout address of ${party} must be a string or null`);
  if (!isRfc3339WithOffset(d.ownershipObservedAt)) fail("ownershipObservedAt must be RFC 3339 with an offset");

  return deepFreeze(d as unknown as SimulationDossier);
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

/** The canonical text stored and hashed. */
export function canonicalSimulationDossier(d: SimulationDossier): string {
  try {
    return canonicalYieldArtifact(d);
  } catch (e) {
    if (e instanceof YieldAmountError) throw new SimulationDossierError("invalid_dossier", e.message);
    throw e;
  }
}

export function simulationDossierHash(d: SimulationDossier): Promise<string> {
  return yieldArtifactHash(d);
}

/** The policy hash a cycle locks: SHA-256 of the canonical calculation policy. */
export function calculationPolicyHash(p: YieldCalculationPolicy): Promise<string> {
  return yieldArtifactHash(p);
}
