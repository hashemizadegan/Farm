/**
 * Y15 (plan §11.1): the read-only devnet verification, as an offline comparison. Holdings rebuilt from the
 * ownership index's events at a slot are compared, owner by owner, with balances exported from an explorer at the
 * same slot. Pure: no network. Running it against a live devnet index and explorer is the Y15 stage itself, which
 * needs the separate devnet approval, the deploy hold lifted and the proposed S and O sign-off; nothing here does
 * that. No settlement, payout, funding or claim is involved.
 */
import { holdersOf, rebuildOwnership, type ChainAssetRef, type OwnershipEvent } from "@metafarm/domain";

export interface ExplorerExport {
  /** The slot the balances were read at. */
  slot: bigint;
  /** Owner address → balance in base units (decimal string). Zero balances may be omitted. */
  balances: Readonly<Record<string, string>>;
}

export type DevnetComparison =
  | { status: "match"; atSlot: bigint; owners: number }
  | { status: "mismatch"; atSlot: bigint; differences: { owner: string; indexed: bigint; explorer: bigint }[] }
  | { status: "not_comparable"; reason: "explorer_after_index" | "conflicting_events" | "invalid_export"; detail: string };

/**
 * Compares the index's holdings of `asset` at `explorer.slot` with the explorer's. Refuses (not_comparable) an export
 * newer than what the index is complete through, an index whose events conflict, and a malformed export.
 */
export function compareWithExplorer(asset: ChainAssetRef, events: readonly OwnershipEvent[], indexedThroughSlot: bigint, explorer: ExplorerExport): DevnetComparison {
  if (explorer.slot > indexedThroughSlot) return { status: "not_comparable", reason: "explorer_after_index", detail: `explorer slot ${explorer.slot} is after the index cursor ${indexedThroughSlot}` };
  const theirs = new Map<string, bigint>();
  for (const [owner, v] of Object.entries(explorer.balances)) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner) || !/^\d{1,30}$/.test(v)) return { status: "not_comparable", reason: "invalid_export", detail: `bad entry ${owner}` };
    if (BigInt(v) > 0n) theirs.set(owner, BigInt(v));
  }
  const own = events.filter((e) => e.asset.network === asset.network && e.asset.rail === asset.rail && e.asset.id === asset.id && e.slot <= explorer.slot);
  const projection = rebuildOwnership(own);
  if (projection.conflicts.length > 0) return { status: "not_comparable", reason: "conflicting_events", detail: `${projection.conflicts.length} conflicting event(s)` };
  const ours = new Map(holdersOf(projection, asset).map((h) => [h.owner, h.amount]));
  const owners = [...new Set([...ours.keys(), ...theirs.keys()])].sort();
  const differences = owners
    .map((owner) => ({ owner, indexed: ours.get(owner) ?? 0n, explorer: theirs.get(owner) ?? 0n }))
    .filter((d) => d.indexed !== d.explorer);
  return differences.length === 0 ? { status: "match", atSlot: explorer.slot, owners: owners.length } : { status: "mismatch", atSlot: explorer.slot, differences };
}
