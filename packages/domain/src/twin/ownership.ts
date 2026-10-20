/**
 * Ownership as the chain records it. Holdings are a projection: they are rebuilt from chain events
 * (mints, transfers, burns read at finality) and never edited directly, so no database row can
 * override what the chain says. Rebuilding from the same events always gives the same holdings,
 * whatever order the events arrive in and however often an event is replayed.
 */
import type { Network, Rail } from "../rwa/model";

/** An asset as the chain identifies it: a Token-2022 mint or a Bubblegum asset id. */
export interface ChainAssetRef {
  network: Network;
  rail: Rail;
  /** Mint address (Token-2022) or asset id (Bubblegum), base58. */
  id: string;
}

export const OWNERSHIP_EVENT_KINDS = ["mint", "transfer", "burn"] as const;
export type OwnershipEventKind = (typeof OWNERSHIP_EVENT_KINDS)[number];

/** One change of ownership, as read from a finalized transaction. */
export interface OwnershipEvent {
  asset: ChainAssetRef;
  kind: OwnershipEventKind;
  /** Null for a mint. */
  from: string | null;
  /** Null for a burn. */
  to: string | null;
  /** Base units. Always 1 for a compressed NFT. */
  amount: bigint;
  slot: bigint;
  /** Position of the transaction in its block, then of the instruction in the transaction. */
  txIndex: number;
  ixIndex: number;
  signature: string;
}

export interface Holding {
  asset: ChainAssetRef;
  owner: string;
  amount: bigint;
  /** Slot of the last event that changed this holding. */
  asOfSlot: bigint;
  lastSignature: string;
}

export type OwnershipConflictReason =
  | "invalid_event"
  | "conflicting_duplicate"
  | "insufficient_balance"
  | "unique_asset_already_minted";

export interface OwnershipConflict {
  event: OwnershipEvent;
  reason: OwnershipConflictReason;
}

export interface OwnershipProjection {
  /** Non-zero holdings, sorted by asset then owner. */
  holdings: Holding[];
  applied: number;
  /** Identical replays of an event already applied. */
  duplicates: number;
  /** Events that contradict the history before them; not applied, kept for reconciliation. */
  conflicts: OwnershipConflict[];
  /** Highest slot seen, or null for no events. */
  lastSlot: bigint | null;
}

export const chainAssetKey = (a: ChainAssetRef): string => `${a.network}:${a.rail}:${a.id}`;
const eventKey = (e: OwnershipEvent): string => `${e.asset.network}:${e.signature}:${e.ixIndex}`;
const fingerprint = (e: OwnershipEvent): string =>
  [chainAssetKey(e.asset), e.kind, e.from ?? "", e.to ?? "", e.amount.toString(), e.slot.toString(), e.txIndex, e.ixIndex].join("|");

const isUnique = (a: ChainAssetRef) => a.rail === "SOLANA_BUBBLEGUM_CNFT";

function wellFormed(e: OwnershipEvent): boolean {
  if (e.amount <= 0n || e.slot < 0n || !Number.isInteger(e.txIndex) || !Number.isInteger(e.ixIndex) || !e.signature) return false;
  if (isUnique(e.asset) && e.amount !== 1n) return false;
  switch (e.kind) {
    case "mint":
      return e.from === null && !!e.to;
    case "transfer":
      return !!e.from && !!e.to;
    case "burn":
      return !!e.from && e.to === null;
    default:
      return false;
  }
}

const compare = (a: OwnershipEvent, b: OwnershipEvent): number =>
  a.slot !== b.slot ? (a.slot < b.slot ? -1 : 1) : a.txIndex !== b.txIndex ? a.txIndex - b.txIndex : a.ixIndex !== b.ixIndex ? a.ixIndex - b.ixIndex : a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;

/** Rebuilds holdings from chain events. Pure and deterministic. */
export function rebuildOwnership(events: readonly OwnershipEvent[]): OwnershipProjection {
  const ordered = [...events].sort(compare);
  const seen = new Map<string, string>();
  const books = new Map<string, { asset: ChainAssetRef; minted: boolean; owners: Map<string, { amount: bigint; slot: bigint; sig: string }> }>();
  const conflicts: OwnershipConflict[] = [];
  let applied = 0;
  let duplicates = 0;
  let lastSlot: bigint | null = null;

  for (const e of ordered) {
    if (lastSlot === null || e.slot > lastSlot) lastSlot = e.slot;
    const key = eventKey(e);
    const fp = fingerprint(e);
    const prior = seen.get(key);
    if (prior !== undefined) {
      if (prior === fp) duplicates++;
      else conflicts.push({ event: e, reason: "conflicting_duplicate" });
      continue;
    }
    if (!wellFormed(e)) {
      conflicts.push({ event: e, reason: "invalid_event" });
      continue;
    }
    const ak = chainAssetKey(e.asset);
    let book = books.get(ak);
    if (!book) books.set(ak, (book = { asset: e.asset, minted: false, owners: new Map() }));
    const balance = (who: string) => book!.owners.get(who)?.amount ?? 0n;
    const set = (who: string, amount: bigint) => {
      if (amount === 0n) book!.owners.delete(who);
      else book!.owners.set(who, { amount, slot: e.slot, sig: e.signature });
    };

    if (e.kind === "mint" && isUnique(e.asset) && book.minted) {
      conflicts.push({ event: e, reason: "unique_asset_already_minted" });
      continue;
    }
    if (e.from !== null && balance(e.from) < e.amount) {
      conflicts.push({ event: e, reason: "insufficient_balance" });
      continue;
    }
    seen.set(key, fp);
    if (e.kind === "mint") book.minted = true;
    if (e.from !== null) set(e.from, balance(e.from) - e.amount);
    if (e.to !== null) set(e.to, balance(e.to) + e.amount);
    applied++;
  }

  const holdings: Holding[] = [];
  for (const ak of [...books.keys()].sort()) {
    const book = books.get(ak)!;
    for (const owner of [...book.owners.keys()].sort()) {
      const h = book.owners.get(owner)!;
      holdings.push({ asset: book.asset, owner, amount: h.amount, asOfSlot: h.slot, lastSignature: h.sig });
    }
  }
  return { holdings, applied, duplicates, conflicts, lastSlot };
}

/** The holders of one asset in a projection. */
export function holdersOf(p: OwnershipProjection, asset: ChainAssetRef): Holding[] {
  const ak = chainAssetKey(asset);
  return p.holdings.filter((h) => chainAssetKey(h.asset) === ak);
}
