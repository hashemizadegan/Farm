/**
 * An in-memory ledger for tests and local development: ownership is rebuilt from a fixed list of
 * chain events with the same projection the real indexer will use. Its readings are marked
 * `fixture` so they can never be mistaken for chain state.
 */
import { holdersOf, rebuildOwnership, type ChainAssetRef, type OwnershipEvent, type OwnershipProjection, type OwnershipReader, type OwnershipReading } from "@metafarm/domain";

export interface FixtureLedger extends OwnershipReader {
  readonly source: "fixture";
  /** Adds events (as an indexer would on its next poll). Replays are harmless. */
  append(events: readonly OwnershipEvent[]): void;
  projection(): OwnershipProjection;
}

export function createFixtureLedger(initial: readonly OwnershipEvent[] = []): FixtureLedger {
  const events: OwnershipEvent[] = [...initial];
  let cached: OwnershipProjection | undefined;
  const projection = () => (cached ??= rebuildOwnership(events));
  return {
    source: "fixture",
    append(more) {
      events.push(...more);
      cached = undefined;
    },
    projection,
    async holdersOf(asset: ChainAssetRef): Promise<OwnershipReading | null> {
      const p = projection();
      const hs = holdersOf(p, asset);
      const touched = events.some((e) => e.asset.network === asset.network && e.asset.rail === asset.rail && e.asset.id === asset.id);
      if (!touched) return null;
      return {
        holders: hs.map((h) => ({ owner: h.owner, amount: h.amount })),
        asOfSlot: hs.reduce<bigint | null>((m, h) => (m === null || h.asOfSlot > m ? h.asOfSlot : m), null) ?? p.lastSlot,
        assurance: "fixture",
      };
    },
  };
}
