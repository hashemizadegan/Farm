/**
 * Ownership read from the platform's ownership index (migration 0020): the finalized events stored for
 * an asset, replayed with the domain's rebuildOwnership. The reading is as of the slot the asset is
 * indexed through, not the slot of its last event. Read-only; takes a loader so this package stays free
 * of database code (the API passes @metafarm/db's readOwnershipIndex).
 *
 * Fails closed: an asset whose stored events contradict each other is not reported at all; the reader
 * throws OwnershipIndexConflictError, which the API shows as `not_indexed` (`reader_unavailable`).
 */
import { holdersOf, rebuildOwnership, type ChainAssetRef, type OwnershipConflict, type OwnershipEvent, type OwnershipReader, type OwnershipReading } from "@metafarm/domain";

export type OwnershipIndexLoader = (asset: ChainAssetRef) => Promise<{ events: OwnershipEvent[]; indexedThroughSlot: bigint } | null>;

export class OwnershipIndexConflictError extends Error {
  constructor(readonly conflicts: OwnershipConflict[]) {
    super(`the ownership index has ${conflicts.length} conflicting event(s) for this asset`);
    this.name = "OwnershipIndexConflictError";
  }
}

export class IndexOwnershipReader implements OwnershipReader {
  readonly source = "chain_index" as const;

  constructor(private readonly load: OwnershipIndexLoader) {}

  async holdersOf(asset: ChainAssetRef): Promise<OwnershipReading | null> {
    const index = await this.load(asset);
    if (!index) return null;
    const own = index.events.filter((e) => e.asset.network === asset.network && e.asset.rail === asset.rail && e.asset.id === asset.id && e.slot <= index.indexedThroughSlot);
    const p = rebuildOwnership(own);
    if (p.conflicts.length > 0) throw new OwnershipIndexConflictError(p.conflicts);
    return {
      holders: holdersOf(p, asset).map((h) => ({ owner: h.owner, amount: h.amount })),
      asOfSlot: index.indexedThroughSlot,
      assurance: "indexer_reported",
    };
  }
}
