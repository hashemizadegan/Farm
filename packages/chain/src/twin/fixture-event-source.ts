/**
 * A fixed list of ownership events served as if read from the chain, for tests and local development:
 * the indexer job can be exercised end to end without an RPC endpoint or credentials.
 */
import type { ChainAssetRef, OwnershipEvent, OwnershipEventSource } from "@metafarm/domain";

export function createFixtureEventSource(events: readonly OwnershipEvent[], finalizedSlot: bigint): OwnershipEventSource & { finalize(slot: bigint, more?: readonly OwnershipEvent[]): void } {
  const all = [...events];
  let finalized = finalizedSlot;
  const same = (a: ChainAssetRef, b: ChainAssetRef) => a.network === b.network && a.rail === b.rail && a.id === b.id;
  return {
    name: "fixture",
    covers: (asset) => all.some((e) => same(e.asset, asset)),
    async eventsAfter(asset, afterSlot) {
      return {
        events: all.filter((e) => same(e.asset, asset) && e.slot <= finalized && (afterSlot === null || e.slot > afterSlot)),
        throughSlot: finalized,
      };
    },
    /** Advances finality, optionally adding events (as the chain would). */
    finalize(slot, more = []) {
      all.push(...more);
      if (slot > finalized) finalized = slot;
    },
  };
}
