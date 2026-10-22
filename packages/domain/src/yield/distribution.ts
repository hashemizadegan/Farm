/**
 * Distribution plan engine (Real Yield Distribution plan, revision 4, §3.2 and §4; pre-Merkle). Pure: no
 * I/O, no clock, no network. It turns a cycle's net distributable yield in settlement base units, plus
 * ownership shares supplied by the caller, into one entry per party or unattributed holding, with an
 * exact conservation check and a ledger carried to the next cycle.
 *
 * What it does not do: compute ownership (Y5), build leaves or a Merkle tree (Y6, D-26), sign, submit,
 * fund or pay anything.
 *
 * Safeguards (fixed, not configurable):
 * - unattributed and withheld amounts are recorded and never redistributed: they stay in the denominator;
 * - dust stays allocated to its party; its payment is deferred and accumulated per party;
 * - every payable amount fits u64; a larger one fails with `amount_out_of_range`;
 * - **a payable entry never has amount 0** (zero-allocation policy, option B, approved 2026-10-22): a party
 *   whose amount (allocation plus deferred dust) is 0 is `deferred` with `deferredReason: "zero_amount"`,
 *   whatever the dust threshold, so `dustThreshold: 0n` stays valid and no zero claim leaf can be built.
 *   A zero amount carries nothing forward (the ledger keeps positive deferred amounts only), so
 *   conservation is unaffected. Precedence: zero amount, then the dust threshold;
 * - a real cycle uses only an `approved` distribution policy; the simulation defaults below are refused.
 *
 * Pending decisions are fields of the policy record, never assumed by the engine:
 * - `remainder` and `dustThreshold`: pending D-9;
 * - `missingPayoutWallet` (refuse the cycle, or withhold the party's amount without a payable entry):
 *   pending D-14 (plan §13.2, question 2).
 */
import { YieldAmountError, assertExactKeys, assertNonNegative, assertU64 } from "./amounts";
import { REMAINDER_RULES, type RemainderRule, splitProportionally } from "./allocation";
import { canonicalYieldArtifact, yieldArtifactHash } from "./artifact";
import { YIELD_RECORD_STATUSES, assertYieldRecordUsable, type YieldRecordStatus } from "./records";

export const MISSING_PAYOUT_WALLET_RULES = ["refuse_cycle", "withhold"] as const;
export type MissingPayoutWalletRule = (typeof MISSING_PAYOUT_WALLET_RULES)[number];

export interface DistributionPolicy {
  id: string;
  version: number;
  status: YieldRecordStatus;
  /** Pending D-9. */
  remainder: RemainderRule;
  /** Settlement base units; a party's amount strictly below this is deferred. Pending D-9. */
  dustThreshold: bigint;
  /** Pending D-14. */
  missingPayoutWallet: MissingPayoutWalletRule;
}

/**
 * Temporary defaults for **simulation cycles only** (status `simulation`). A real cycle refuses this
 * record, so none of these values can reach a real distribution before its decision is approved.
 */
export const SIMULATION_DISTRIBUTION_POLICY: DistributionPolicy = Object.freeze({
  id: "simulation-distribution-defaults",
  version: 1,
  status: "simulation",
  remainder: "largest_remainder", // pending D-9: the plan's provisional recommendation, simulation only
  dustThreshold: 0n, // pending D-9: no dust threshold in simulation
  missingPayoutWallet: "withhold", // pending D-14 (§13.2 Q2): simulation only
});

export type DistributionShare = { kind: "party"; partyId: string; payoutWallet: string | null; weight: bigint } | { kind: "unattributed"; holderKey: string; weight: bigint };

/** Carried from the previous cycle's plan (empty for a first cycle). */
export interface DistributionLedger {
  /** Remainder carried by the `carry` rule. */
  carriedRemainder: bigint;
  /** Deferred dust per party, unique party ids. */
  deferred: { partyId: string; amount: bigint }[];
}

/** The ledger of a first cycle: nothing carried. */
export function emptyDistributionLedger(): DistributionLedger {
  return { carriedRemainder: 0n, deferred: [] };
}

export const DISTRIBUTION_ENTRY_STATES = ["payable", "deferred", "withheld", "unattributed", "carried", "claimed", "voided", "expired", "released"] as const;
export type DistributionEntryState = (typeof DISTRIBUTION_ENTRY_STATES)[number];

export interface DistributionEntry {
  kind: "party" | "unattributed";
  partyId: string | null;
  holderKey: string | null;
  payoutWallet: string | null;
  weight: bigint;
  /** This cycle's allocation. */
  allocated: bigint;
  /** Dust deferred to this party in earlier cycles and included here. */
  deferredIn: bigint;
  /** allocated + deferredIn. */
  amount: bigint;
  state: "payable" | "deferred" | "withheld" | "unattributed";
  /** Why a `deferred` entry is not payable; null for every other state. Auditable in the plan. */
  deferredReason: DistributionDeferredReason | null;
}

/** Why a party's entry is deferred rather than payable. */
export const DISTRIBUTION_DEFERRED_REASONS = ["zero_amount", "below_dust_threshold"] as const;
export type DistributionDeferredReason = (typeof DISTRIBUTION_DEFERRED_REASONS)[number];

/**
 * The state of a party entry, from its payout wallet, amount and the dust threshold. Fixed rule, shared by
 * the planner and by `distributionPlanProblems`: no wallet → withheld; amount 0 → deferred (zero_amount);
 * amount below the threshold → deferred (below_dust_threshold); otherwise payable.
 */
export function partyEntryState(payoutWallet: string | null, amount: bigint, dustThreshold: bigint): { state: "payable" | "deferred" | "withheld"; deferredReason: DistributionDeferredReason | null } {
  if (payoutWallet === null) return { state: "withheld", deferredReason: null };
  if (amount === 0n) return { state: "deferred", deferredReason: "zero_amount" };
  if (amount < dustThreshold) return { state: "deferred", deferredReason: "below_dust_threshold" };
  return { state: "payable", deferredReason: null };
}

export interface DistributionPlan {
  scheme: typeof DISTRIBUTION_PLAN_SCHEME;
  cycle: { id: string; version: number; simulation: boolean };
  policy: DistributionPolicy;
  netDistributableYield: bigint;
  ledgerIn: DistributionLedger;
  /** In canonical order: parties by id, then unattributed holdings by key (code-unit order). */
  entries: DistributionEntry[];
  totals: { payable: bigint; deferred: bigint; withheld: bigint; unattributed: bigint; remainderCarried: bigint };
  ledgerOut: DistributionLedger;
}

export const DISTRIBUTION_PLAN_SCHEME = "metafarm-yield-distribution-plan/1";

export type DistributionErrorCode = "invalid_input" | "missing_payout_wallet" | "invalid_transition" | "future_phase";

export class DistributionError extends Error {
  constructor(
    readonly code: DistributionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DistributionError";
  }
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "" && v.trim() === v;
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const hexOf = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Every problem with a distribution policy record, or an empty list. */
export function distributionPolicyProblems(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["a distribution policy must be an object"];
  const o = v as Record<string, unknown>;
  const out: string[] = [];
  const extra = Object.keys(o).filter((k) => !["id", "version", "status", "remainder", "dustThreshold", "missingPayoutWallet"].includes(k));
  if (extra.length) out.push(`distribution policy has unsupported keys: ${extra.sort().join(", ")}`);
  if (!nonEmpty(o.id)) out.push("id must be a non-empty string");
  if (!(typeof o.version === "number" && Number.isSafeInteger(o.version) && o.version >= 1)) out.push("version must be an integer ≥ 1");
  if (!(YIELD_RECORD_STATUSES as readonly unknown[]).includes(o.status)) out.push(`status must be one of ${YIELD_RECORD_STATUSES.join(", ")}`);
  if (!(REMAINDER_RULES as readonly unknown[]).includes(o.remainder)) out.push(`remainder must be one of ${REMAINDER_RULES.join(", ")}`);
  if (typeof o.dustThreshold !== "bigint" || o.dustThreshold < 0n) out.push("dustThreshold must be a bigint ≥ 0");
  if (!(MISSING_PAYOUT_WALLET_RULES as readonly unknown[]).includes(o.missingPayoutWallet)) out.push(`missingPayoutWallet must be one of ${MISSING_PAYOUT_WALLET_RULES.join(", ")}`);
  return out;
}

function checkLedger(l: DistributionLedger): void {
  assertExactKeys("ledger", l, ["carriedRemainder", "deferred"]);
  assertNonNegative("ledger.carriedRemainder", l.carriedRemainder);
  if (!Array.isArray(l.deferred)) throw new DistributionError("invalid_input", "ledger.deferred must be a list");
  const seen = new Set<string>();
  for (const d of l.deferred) {
    assertExactKeys("ledger.deferred entry", d, ["partyId", "amount"]);
    if (!nonEmpty(d.partyId)) throw new DistributionError("invalid_input", "a deferred entry needs a party id");
    if (seen.has(d.partyId)) throw new DistributionError("invalid_input", `party ${d.partyId} is deferred twice`);
    seen.add(d.partyId);
    assertNonNegative(`deferred amount of ${d.partyId}`, d.amount);
  }
}

/**
 * Builds the distribution plan. `netDistributableYield` is in settlement base units (the result of the
 * waterfall converted once, Y2). Shares come from the ownership snapshot (Y5); this engine takes them as
 * given and checks only their shape.
 */
export function planDistribution(input: {
  cycle: { id: string; version: number; simulation: boolean };
  policy: DistributionPolicy;
  netDistributableYield: bigint;
  shares: readonly DistributionShare[];
  ledger: DistributionLedger;
}): DistributionPlan {
  assertExactKeys("distribution input", input, ["cycle", "policy", "netDistributableYield", "shares", "ledger"]);
  const { cycle, policy, netDistributableYield, shares, ledger } = input;
  assertExactKeys("cycle", cycle, ["id", "version", "simulation"]);
  if (!nonEmpty(cycle.id) || !Number.isSafeInteger(cycle.version) || cycle.version < 1 || typeof cycle.simulation !== "boolean") throw new DistributionError("invalid_input", "the cycle needs an id, a version ≥ 1 and an explicit simulation flag");
  const problems = distributionPolicyProblems(policy);
  if (problems.length) throw new DistributionError("invalid_input", `invalid distribution policy: ${problems.join("; ")}`);
  assertYieldRecordUsable(cycle, { status: policy.status, kind: "distribution policy" });
  assertNonNegative("netDistributableYield", netDistributableYield);
  checkLedger(ledger);
  if (!Array.isArray(shares) || shares.length === 0) throw new DistributionError("invalid_input", "at least one share is required");

  // Validate shares and give each a unique, ordered key.
  const keyed = shares.map((s) => {
    if (!s || typeof s !== "object") throw new DistributionError("invalid_input", "a share must be an object");
    if (s.kind === "party") {
      assertExactKeys("party share", s as unknown, ["kind", "partyId", "payoutWallet", "weight"]);
      if (!nonEmpty(s.partyId)) throw new DistributionError("invalid_input", "a party share needs a party id");
      if (s.payoutWallet !== null && !nonEmpty(s.payoutWallet)) throw new DistributionError("invalid_input", `party ${s.partyId} has an invalid payout wallet (null for none)`);
      assertNonNegative(`weight of ${s.partyId}`, s.weight);
      return { key: `p:${s.partyId}`, share: s };
    }
    if (s.kind === "unattributed") {
      assertExactKeys("unattributed share", s as unknown, ["kind", "holderKey", "weight"]);
      if (!nonEmpty(s.holderKey)) throw new DistributionError("invalid_input", "an unattributed share needs a holder key");
      assertNonNegative(`weight of ${s.holderKey}`, s.weight);
      return { key: `u:${s.holderKey}`, share: s };
    }
    throw new DistributionError("invalid_input", "a share's kind must be party or unattributed");
  });
  const keys = new Set<string>();
  for (const k of keyed) {
    if (keys.has(k.key)) throw new DistributionError("invalid_input", `share ${k.key} appears twice`);
    keys.add(k.key);
  }
  keyed.sort((a, b) => byCodeUnits(a.key, b.key));

  if (policy.missingPayoutWallet === "refuse_cycle") {
    const missing = keyed.filter((k) => k.share.kind === "party" && k.share.payoutWallet === null).map((k) => (k.share as { partyId: string }).partyId);
    if (missing.length) throw new DistributionError("missing_payout_wallet", `parties without a payout wallet: ${missing.join(", ")}`);
  }

  // Split this cycle's yield plus any carried remainder. Dust marking is done below, after deferred
  // amounts are added, so the split itself uses no dust threshold.
  const total = netDistributableYield + ledger.carriedRemainder;
  const split = splitProportionally(
    total,
    keyed.map((k) => ({ recipient: hexOf(k.key), weight: k.share.weight })),
    { remainder: policy.remainder, dustThreshold: 0n },
  );
  const allocatedByHex = new Map(split.allocations.map((a) => [a.recipient, a.amount]));
  const deferredIn = new Map(ledger.deferred.map((d) => [d.partyId, d.amount]));

  const entries: DistributionEntry[] = keyed.map(({ key, share }) => {
    const allocated = allocatedByHex.get(hexOf(key))!;
    if (share.kind === "unattributed") {
      return { kind: "unattributed", partyId: null, holderKey: share.holderKey, payoutWallet: null, weight: share.weight, allocated, deferredIn: 0n, amount: allocated, state: "unattributed", deferredReason: null };
    }
    const din = deferredIn.get(share.partyId) ?? 0n;
    const amount = allocated + din;
    const { state, deferredReason } = partyEntryState(share.payoutWallet, amount, policy.dustThreshold);
    if (state === "payable") assertU64(`payable amount of ${share.partyId}`, amount);
    return { kind: "party", partyId: share.partyId, holderKey: null, payoutWallet: share.payoutWallet, weight: share.weight, allocated, deferredIn: din, amount, state, deferredReason };
  });

  // Deferred dust of parties with no share this cycle stays theirs and is carried unchanged.
  const present = new Set(entries.filter((e) => e.partyId !== null).map((e) => e.partyId!));
  const absentDeferred = ledger.deferred.filter((d) => !present.has(d.partyId) && d.amount > 0n);
  const deferredOut = [...entries.filter((e) => e.state === "deferred" && e.amount > 0n).map((e) => ({ partyId: e.partyId!, amount: e.amount })), ...absentDeferred.map((d) => ({ ...d }))].sort((a, b) =>
    byCodeUnits(a.partyId, b.partyId),
  );

  const sum = (state: DistributionEntry["state"]) => entries.filter((e) => e.state === state).reduce((n, e) => n + e.amount, 0n);
  const totals = {
    payable: sum("payable"),
    deferred: deferredOut.reduce((n, d) => n + d.amount, 0n),
    withheld: sum("withheld"),
    unattributed: sum("unattributed"),
    remainderCarried: split.remainder,
  };

  // Conservation: everything in equals everything out, exactly.
  const inflow = netDistributableYield + ledger.carriedRemainder + ledger.deferred.reduce((n, d) => n + d.amount, 0n);
  const outflow = totals.payable + totals.deferred + totals.withheld + totals.unattributed + totals.remainderCarried;
  if (inflow !== outflow) throw new YieldAmountError("invalid_parameter", `internal: distribution does not conserve (${inflow} in, ${outflow} out)`);

  return {
    scheme: DISTRIBUTION_PLAN_SCHEME,
    cycle: { ...cycle },
    policy: { ...policy },
    netDistributableYield,
    ledgerIn: { carriedRemainder: ledger.carriedRemainder, deferred: [...ledger.deferred].map((d) => ({ ...d })).sort((a, b) => byCodeUnits(a.partyId, b.partyId)) },
    entries,
    totals,
    ledgerOut: { carriedRemainder: split.remainder, deferred: deferredOut },
  };
}

/**
 * Re-checks a plan's entries against the fixed state rule (e.g. a plan embedded in an artifact): every
 * amount is allocation plus deferred dust, every state and deferred reason follows `partyEntryState`, and
 * no payable entry has amount 0. Returns the problems found.
 */
export function distributionPlanProblems(plan: DistributionPlan): string[] {
  const out: string[] = [];
  for (const e of plan?.entries ?? []) {
    const name = e.partyId ?? e.holderKey ?? "?";
    if (e.amount !== e.allocated + e.deferredIn) out.push(`entry ${name}: amount is not allocation plus deferred dust`);
    if (e.kind === "unattributed") {
      if (e.state !== "unattributed" || e.deferredReason !== null || e.deferredIn !== 0n) out.push(`entry ${name}: an unattributed holding must be unattributed, with no deferred reason`);
      continue;
    }
    const want = partyEntryState(e.payoutWallet, e.amount, plan.policy.dustThreshold);
    if (e.state !== want.state || e.deferredReason !== want.deferredReason) out.push(`entry ${name}: state ${e.state}/${String(e.deferredReason)} should be ${want.state}/${String(want.deferredReason)}`);
    if (e.state === "payable" && e.amount === 0n) out.push(`entry ${name}: a payable entry has amount 0`);
  }
  return out;
}

/** Canonical JSON of a plan (bigints as decimal strings, keys sorted). */
export function canonicalDistributionPlan(p: DistributionPlan): string {
  return canonicalYieldArtifact(p);
}

/** SHA-256 (lowercase hex) of the canonical plan. */
export function distributionPlanHash(p: DistributionPlan): Promise<string> {
  return yieldArtifactHash(p);
}

// ── Entry lifecycle ─────────────────────────────────────────────────────────────────────────────────

export const DISTRIBUTION_ENTRY_COMMANDS = ["claim", "void", "expire", "carry", "release"] as const;
export type DistributionEntryCommand = (typeof DISTRIBUTION_ENTRY_COMMANDS)[number];

export interface DistributionEntryTransition {
  command: DistributionEntryCommand;
  from: DistributionEntryState;
  to: DistributionEntryState;
  /** Needs a separately approved phase or decision; always refused here. */
  future?: { reason: string };
}

/** Every allowed entry transition. Anything else is refused. */
export const DISTRIBUTION_ENTRY_TRANSITIONS: readonly DistributionEntryTransition[] = [
  { command: "claim", from: "payable", to: "claimed", future: { reason: "claims need funding and a payout rail (D-25), not approved" } },
  { command: "expire", from: "payable", to: "expired", future: { reason: "claim expiry is D-27; with none approved, nothing expires" } },
  // A published correction supersedes the plan (plan §2.4): its open entries are voided, never deleted.
  { command: "void", from: "payable", to: "voided" },
  { command: "void", from: "deferred", to: "voided" },
  { command: "void", from: "withheld", to: "voided" },
  { command: "void", from: "unattributed", to: "voided" },
  // Deferred dust moves into the next cycle's ledger.
  { command: "carry", from: "deferred", to: "carried" },
  { command: "release", from: "withheld", to: "released", future: { reason: "releasing withheld amounts is D-14 / D-13, not approved" } },
  { command: "release", from: "unattributed", to: "released", future: { reason: "the disposition of unattributed amounts is D-13, not approved" } },
];

export const DISTRIBUTION_ENTRY_TERMINAL_STATES = ["carried", "claimed", "voided", "expired", "released"] as const satisfies readonly DistributionEntryState[];

/** The state a command moves an entry to; refuses unlisted and future transitions. */
export function distributionEntryTransition(from: DistributionEntryState, command: DistributionEntryCommand): DistributionEntryState {
  const t = DISTRIBUTION_ENTRY_TRANSITIONS.find((x) => x.from === from && x.command === command);
  if (!t) throw new DistributionError("invalid_transition", `an entry cannot ${command} from ${from}`);
  if (t.future) throw new DistributionError("future_phase", `${command} from ${from}: ${t.future.reason}`);
  return t.to;
}
