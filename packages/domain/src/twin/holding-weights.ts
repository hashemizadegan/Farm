/**
 * Y5 (real-yield plan revision 4): slot-weighted holdings and the weighted ownership input.
 *
 * D-12 (owner decision for the Build gate, 2026-10-22): holdings are weighted by **slots** held within the
 * cycle window `(startSlot, endSlot]`, using only the integer slots the ownership index records. This is not the
 * real-cycle allocation policy: D-12's model selection (Real gate) stays open, and the point-in-time view is
 * computed alongside for comparison (plan §4.2).
 *
 * D-17 (owner decision, 2026-10-22), service layer: a non-simulation input may only be built from verified RPC
 * history (a recorded cluster identity, Y0). Fixture history is accepted for simulation only. Mixed or
 * ambiguous provenance is refused upstream by the history reader.
 *
 * Definitions (all integers, deterministic):
 * - Events are applied in chain order (slot, transaction index, instruction index, signature); identical replays
 *   count once; any conflict refuses the computation (`rebuildOwnership` decides what a conflict is).
 * - The balance an owner has **after all events of slot s** counts for slot s.
 * - weight(owner) = Σ over slots s in (startSlot, endSlot] of balance(owner, s).
 * - pointInTimeUnits(owner) = balance(owner, endSlot).
 * - Events after endSlot are ignored; events at or before startSlot only set the opening balances.
 *
 * Bounds: the window spans at most MAX_SLOT_SPAN slots, and every amount is at most u64, so a weight is below
 * 2^96. Every weight, per-party sum and total is still checked against WEIGHT_MAX (u128) and refused above it.
 * Weights are bigints with no other limit: they are deliberately **not** the 64-bit `rawShares` of the yield
 * snapshot (#75), which slot-weighted values can exceed.
 */
import { canonicalJson } from "../harvest";
import { contentHash } from "./commitments";
import { type ChainAssetRef, type OwnershipEvent, chainAssetKey, rebuildOwnership } from "./ownership";

export const WEIGHTED_OWNERSHIP_SCHEME = "metafarm-weighted-ownership/1";
export const HOLDING_MODEL = "slot_weighted" as const;
/** The largest window: 2^32 slots (decades at current slot times). */
export const MAX_SLOT_SPAN = 2n ** 32n;
/** u128: the largest weight, per-party sum or total accepted. */
export const WEIGHT_MAX = 2n ** 128n - 1n;
const U64_MAX = 2n ** 64n - 1n;

export const HOLDING_WEIGHT_ERROR_CODES = [
  "not_indexed",
  "invalid_window",
  "invalid_input",
  "foreign_event",
  "ownership_conflict",
  "incomplete_history",
  "unverified_source",
  "fixture_in_real_cycle",
  "no_holdings",
  "duplicate_wallet",
  "weight_out_of_range",
] as const;
export type HoldingWeightErrorCode = (typeof HOLDING_WEIGHT_ERROR_CODES)[number];

export class HoldingWeightError extends Error {
  constructor(
    readonly code: HoldingWeightErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HoldingWeightError";
  }
}

const fail = (code: HoldingWeightErrorCode, message: string): never => {
  throw new HoldingWeightError(code, message);
};

/** The cycle window: slots strictly after startSlot, up to and including endSlot. */
export interface HoldingWindow {
  startSlot: bigint;
  endSlot: bigint;
}

export interface OwnerWeight {
  owner: string;
  weight: bigint;
  pointInTimeUnits: bigint;
}

function checkWindow(w: HoldingWindow): void {
  if (!w || typeof w.startSlot !== "bigint" || typeof w.endSlot !== "bigint") fail("invalid_window", "the window needs bigint startSlot and endSlot");
  if (w.startSlot < 0n || w.endSlot > U64_MAX) fail("invalid_window", "window slots must be u64");
  if (w.endSlot <= w.startSlot) fail("invalid_window", "endSlot must be after startSlot (the window is (startSlot, endSlot])");
  if (w.endSlot - w.startSlot > MAX_SLOT_SPAN) fail("invalid_window", `the window spans more than ${MAX_SLOT_SPAN} slots`);
}

const order = (a: OwnershipEvent, b: OwnershipEvent): number =>
  a.slot !== b.slot ? (a.slot < b.slot ? -1 : 1) : a.txIndex !== b.txIndex ? a.txIndex - b.txIndex : a.ixIndex !== b.ixIndex ? a.ixIndex - b.ixIndex : a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;

/**
 * Slot-weighted holdings of one asset over a window. Pure and deterministic. Refuses events of another asset,
 * any ownership conflict up to endSlot, and an empty result (nobody held the asset in the window).
 */
export function slotWeightedHoldings(asset: ChainAssetRef, events: readonly OwnershipEvent[], window: HoldingWindow): { owners: OwnerWeight[]; totalWeight: bigint; pointInTimeTotal: bigint; eventsUsed: OwnershipEvent[] } {
  checkWindow(window);
  if (!Array.isArray(events)) fail("invalid_input", "events must be a list");
  const ak = chainAssetKey(asset);
  for (const e of events) if (!e || !e.asset || chainAssetKey(e.asset) !== ak) fail("foreign_event", `an event belongs to another asset than ${ak}`);
  for (const e of events) if (typeof e.amount !== "bigint" || e.amount > U64_MAX || typeof e.slot !== "bigint" || e.slot > U64_MAX) fail("invalid_input", "event amounts and slots must be u64 bigints");

  const used = events.filter((e) => e.slot <= window.endSlot);
  const projection = rebuildOwnership(used);
  if (projection.conflicts.length) fail("ownership_conflict", `${projection.conflicts.length} conflicting event(s) up to slot ${window.endSlot} (${projection.conflicts[0]!.reason})`);

  // Identical replays count once (rebuildOwnership accepted them as duplicates).
  const seen = new Set<string>();
  const ordered = [...used].sort(order).filter((e) => {
    const k = `${e.signature}:${e.ixIndex}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const balance = new Map<string, bigint>();
  const weight = new Map<string, bigint>();
  const accrue = (slots: bigint) => {
    if (slots <= 0n) return;
    for (const [owner, units] of balance) weight.set(owner, (weight.get(owner) ?? 0n) + units * slots);
  };
  const apply = (e: OwnershipEvent) => {
    if (e.from !== null) {
      const left = (balance.get(e.from) ?? 0n) - e.amount;
      if (left === 0n) balance.delete(e.from);
      else balance.set(e.from, left);
    }
    if (e.to !== null) balance.set(e.to, (balance.get(e.to) ?? 0n) + e.amount);
  };

  // `counted` is the last slot whose balance has been added to the weights.
  let counted = window.startSlot;
  let i = 0;
  while (i < ordered.length) {
    const slot = ordered[i]!.slot;
    if (slot > window.startSlot) {
      accrue(slot - 1n - counted); // slots counted+1 … slot-1 at the balances before this slot's events
      counted = slot - 1n;
    }
    while (i < ordered.length && ordered[i]!.slot === slot) apply(ordered[i++]!);
  }
  accrue(window.endSlot - counted); // the remaining slots, including endSlot, at the closing balances

  const owners = [...new Set([...weight.keys(), ...balance.keys()])]
    .sort()
    .map((owner) => ({ owner, weight: weight.get(owner) ?? 0n, pointInTimeUnits: balance.get(owner) ?? 0n }))
    .filter((o) => o.weight > 0n || o.pointInTimeUnits > 0n);
  const totalWeight = owners.reduce((n, o) => n + o.weight, 0n);
  const pointInTimeTotal = owners.reduce((n, o) => n + o.pointInTimeUnits, 0n);
  for (const o of owners) if (o.weight > WEIGHT_MAX) fail("weight_out_of_range", `the weight of ${o.owner} exceeds u128`);
  if (totalWeight > WEIGHT_MAX) fail("weight_out_of_range", "the total weight exceeds u128");
  if (totalWeight === 0n) fail("no_holdings", `nobody held ${ak} in (${window.startSlot}, ${window.endSlot}]`);
  return { owners, totalWeight, pointInTimeTotal, eventsUsed: ordered };
}

// ── The weighted ownership input ────────────────────────────────────────────────────────────────

/** Where the events came from, as the history reader established it. */
export interface OwnershipProvenance {
  sourceKind: "rpc" | "fixture";
  /** The verified cluster identity (Y0) the RPC history is bound to; null for fixture history. */
  sourceIdentity: { id: string; network: string; genesisHash: string } | null;
  /** The slot the asset is indexed through (complete history up to here). */
  cursorSlot: bigint;
}

export interface WeightedPartyEntry {
  partyId: string;
  /** The party's registered wallets that held the asset in the window, sorted. */
  wallets: string[];
  weight: bigint;
  pointInTimeUnits: bigint;
}

export interface WeightedUnattributedEntry {
  /** The holding address: no party is registered for it (player wallets are never parties). */
  holderKey: string;
  weight: bigint;
  pointInTimeUnits: bigint;
}

/**
 * The input Y5 hands to allocation: weights per party (summed over the party's wallets) and per unattributed
 * address, with the provenance and a commitment to all of it. Weights are unbounded bigints (≤ u128 by check),
 * not 64-bit shares.
 */
export interface WeightedOwnershipInput {
  scheme: typeof WEIGHTED_OWNERSHIP_SCHEME;
  model: typeof HOLDING_MODEL;
  asset: ChainAssetRef;
  window: HoldingWindow;
  simulation: boolean;
  provenance: OwnershipProvenance;
  /** SHA-256 of the canonical events used (slot ≤ endSlot, chain order, replays once). */
  eventsSha256: string;
  parties: WeightedPartyEntry[];
  unattributed: WeightedUnattributedEntry[];
  totalWeight: bigint;
  pointInTimeTotal: bigint;
  /** SHA-256 of the canonical committed content (everything above). */
  commitment: string;
}

/** The ownership history of one asset, as a verified-history reader returns it. */
export interface OwnershipHistory {
  asset: ChainAssetRef;
  events: OwnershipEvent[];
  provenance: OwnershipProvenance;
}

const str = (v: bigint) => v.toString();
const committedEvents = (events: readonly OwnershipEvent[]) =>
  events.map((e) => ({ kind: e.kind, from: e.from, to: e.to, amount: str(e.amount), slot: str(e.slot), txIndex: e.txIndex, ixIndex: e.ixIndex, signature: e.signature }));

function committedContent(i: Omit<WeightedOwnershipInput, "commitment">) {
  return {
    scheme: i.scheme,
    model: i.model,
    asset: i.asset,
    window: { startSlot: str(i.window.startSlot), endSlot: str(i.window.endSlot) },
    simulation: i.simulation,
    provenance: { sourceKind: i.provenance.sourceKind, sourceIdentity: i.provenance.sourceIdentity, cursorSlot: str(i.provenance.cursorSlot) },
    eventsSha256: i.eventsSha256,
    parties: i.parties.map((p) => ({ partyId: p.partyId, wallets: p.wallets, weight: str(p.weight), pointInTimeUnits: str(p.pointInTimeUnits) })),
    unattributed: i.unattributed.map((u) => ({ holderKey: u.holderKey, weight: str(u.weight), pointInTimeUnits: str(u.pointInTimeUnits) })),
    totalWeight: str(i.totalWeight),
    pointInTimeTotal: str(i.pointInTimeTotal),
  };
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

/** The D-17 service-layer rule and the completeness rule (§4.3), shared by build and re-check. */
function provenanceProblem(p: OwnershipProvenance, asset: ChainAssetRef, window: HoldingWindow, simulation: boolean): [HoldingWeightErrorCode, string] | null {
  if (p.sourceKind !== "rpc" && p.sourceKind !== "fixture") return ["invalid_input", "sourceKind must be rpc or fixture"];
  if (p.sourceKind === "rpc" && (!p.sourceIdentity || p.sourceIdentity.network !== asset.network)) return ["unverified_source", "RPC history must be bound to a verified cluster identity of the asset's network"];
  if (p.sourceKind === "fixture" && p.sourceIdentity !== null) return ["invalid_input", "fixture history carries no cluster identity"];
  if (!simulation && p.sourceKind !== "rpc") return ["fixture_in_real_cycle", "a non-simulation input can only use verified RPC history (D-17)"];
  if (typeof p.cursorSlot !== "bigint" || p.cursorSlot < window.endSlot) return ["incomplete_history", `the asset is indexed through ${String(p.cursorSlot)}, not through endSlot ${window.endSlot}`];
  return null;
}

/**
 * Builds the weighted ownership input from a history and the tenant's wallet-to-party map. Fails closed:
 * fixture history for a non-simulation input, unverified RPC history, a cursor short of endSlot, conflicts,
 * an empty window, or a wallet registered to two parties are refused with a stable code.
 */
export async function buildWeightedOwnershipInput(params: { history: OwnershipHistory; window: HoldingWindow; partyOfWallet: ReadonlyMap<string, string>; simulation: boolean }): Promise<WeightedOwnershipInput> {
  const { history, window, partyOfWallet, simulation } = params;
  if (typeof simulation !== "boolean") fail("invalid_input", "simulation must be given explicitly");
  if (!history || !history.asset || !history.provenance) fail("invalid_input", "a history needs an asset and its provenance");
  checkWindow(window);
  const problem = provenanceProblem(history.provenance, history.asset, window, simulation);
  if (problem) fail(problem[0], problem[1]);

  const { owners, totalWeight, pointInTimeTotal, eventsUsed } = slotWeightedHoldings(history.asset, history.events, window);

  const parties = new Map<string, WeightedPartyEntry>();
  const unattributed: WeightedUnattributedEntry[] = [];
  for (const o of owners) {
    const partyId = partyOfWallet.get(o.owner);
    if (partyId === undefined) {
      unattributed.push({ holderKey: o.owner, weight: o.weight, pointInTimeUnits: o.pointInTimeUnits });
      continue;
    }
    const p = parties.get(partyId) ?? { partyId, wallets: [], weight: 0n, pointInTimeUnits: 0n };
    p.wallets.push(o.owner);
    p.weight += o.weight;
    p.pointInTimeUnits += o.pointInTimeUnits;
    parties.set(partyId, p);
  }
  for (const p of parties.values()) if (p.weight > WEIGHT_MAX) fail("weight_out_of_range", `the weight of party ${p.partyId} exceeds u128`);
  const partyList = [...parties.values()].sort((a, b) => (a.partyId < b.partyId ? -1 : a.partyId > b.partyId ? 1 : 0)).map((p) => ({ ...p, wallets: [...p.wallets].sort() }));
  for (const p of partyList) if (unattributed.some((u) => u.holderKey === p.partyId)) fail("duplicate_wallet", `party id ${p.partyId} collides with a holder key`);

  const base = {
    scheme: WEIGHTED_OWNERSHIP_SCHEME,
    model: HOLDING_MODEL,
    asset: { network: history.asset.network, rail: history.asset.rail, id: history.asset.id },
    window: { startSlot: window.startSlot, endSlot: window.endSlot },
    simulation,
    provenance: {
      sourceKind: history.provenance.sourceKind,
      sourceIdentity: history.provenance.sourceIdentity ? { ...history.provenance.sourceIdentity } : null,
      cursorSlot: history.provenance.cursorSlot,
    },
    eventsSha256: await contentHash(canonicalJson(committedEvents(eventsUsed))),
    parties: partyList,
    unattributed,
    totalWeight,
    pointInTimeTotal,
  } as const;
  const input: WeightedOwnershipInput = { ...base, commitment: await contentHash(canonicalJson(committedContent(base))) };
  return deepFreeze(input);
}

/** Re-checks a weighted ownership input (e.g. one stored with a cycle). Returns the problems found. */
export async function weightedOwnershipProblems(i: WeightedOwnershipInput): Promise<string[]> {
  const out: string[] = [];
  if (i?.scheme !== WEIGHTED_OWNERSHIP_SCHEME || i.model !== HOLDING_MODEL) return ["not a weighted ownership input"];
  try {
    checkWindow(i.window);
  } catch (e) {
    out.push((e as Error).message);
  }
  const problem = provenanceProblem(i.provenance, i.asset, i.window, i.simulation);
  if (problem) out.push(problem[1]);
  const all = [...i.parties.map((p) => p.weight), ...i.unattributed.map((u) => u.weight)];
  if (all.some((w) => typeof w !== "bigint" || w < 0n || w > WEIGHT_MAX)) out.push("weights must be bigints in [0, u128]");
  else if (all.reduce((a, b) => a + b, 0n) !== i.totalWeight) out.push("totalWeight is not the sum of the weights");
  const pit = [...i.parties.map((p) => p.pointInTimeUnits), ...i.unattributed.map((u) => u.pointInTimeUnits)];
  if (pit.every((x) => typeof x === "bigint") && pit.reduce((a, b) => a + b, 0n) !== i.pointInTimeTotal) out.push("pointInTimeTotal is not the sum of the point-in-time units");
  for (let k = 1; k < i.parties.length; k++) if (!(i.parties[k - 1]!.partyId < i.parties[k]!.partyId)) out.push("parties are not in canonical order");
  for (let k = 1; k < i.unattributed.length; k++) if (!(i.unattributed[k - 1]!.holderKey < i.unattributed[k]!.holderKey)) out.push("unattributed holders are not in canonical order");
  try {
    const { commitment: _c, ...rest } = i;
    if ((await contentHash(canonicalJson(committedContent(rest)))) !== i.commitment) out.push("the input does not hash to its commitment");
  } catch (e) {
    out.push(`the input cannot be hashed: ${(e as Error).message}`);
  }
  return [...new Set(out)];
}
