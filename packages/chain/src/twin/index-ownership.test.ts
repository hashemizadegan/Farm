/** Ownership from the index: rebuilt from stored events as of the indexed slot; fails closed on conflicts. */
import { describe, expect, it } from "vitest";
import type { OwnershipEvent } from "@metafarm/domain";
import { FIXTURE_ASSETS, FIXTURE_EVENTS, FIXTURE_WALLETS } from "./fixtures";
import { createFixtureEventSource } from "./fixture-event-source";
import { IndexOwnershipReader, OwnershipIndexConflictError } from "./index-ownership";

const share = FIXTURE_ASSETS.shareMint;
const shareEvents = FIXTURE_EVENTS.filter((e) => e.asset.id === share.id);

describe("IndexOwnershipReader", () => {
  it("says nothing about an asset the index does not track", async () => {
    const reader = new IndexOwnershipReader(async () => null);
    expect(reader.source).toBe("chain_index");
    expect(await reader.holdersOf(share)).toBeNull();
  });

  it("rebuilds holders from the stored events, as of the slot the asset is indexed through", async () => {
    const reader = new IndexOwnershipReader(async () => ({ events: [...shareEvents], indexedThroughSlot: 310_001_000n }));
    const r = await reader.holdersOf(share);
    expect(r).toEqual({
      holders: [
        { owner: FIXTURE_WALLETS.custodian, amount: 750_000n },
        { owner: FIXTURE_WALLETS.investor, amount: 250_000n },
      ].sort((a, b) => (a.owner < b.owner ? -1 : 1)),
      asOfSlot: 310_001_000n,
      assurance: "indexer_reported",
    });
  });

  it("ignores events after the indexed slot and events of other assets", async () => {
    const reader = new IndexOwnershipReader(async () => ({ events: [...FIXTURE_EVENTS], indexedThroughSlot: 310_000_500n }));
    expect(await reader.holdersOf(share)).toEqual({ holders: [{ owner: FIXTURE_WALLETS.custodian, amount: 1_000_000n }], asOfSlot: 310_000_500n, assurance: "indexer_reported" });
  });

  it("reports an indexed asset with no holders as holding nothing, not as unknown", async () => {
    const reader = new IndexOwnershipReader(async () => ({ events: [], indexedThroughSlot: 310_000_000n }));
    expect(await reader.holdersOf(share)).toEqual({ holders: [], asOfSlot: 310_000_000n, assurance: "indexer_reported" });
  });

  it("fails closed when the stored events contradict each other", async () => {
    const forged: OwnershipEvent = { ...shareEvents[1]!, amount: 999n };
    const reader = new IndexOwnershipReader(async () => ({ events: [...shareEvents, forged], indexedThroughSlot: 310_001_000n }));
    await expect(reader.holdersOf(share)).rejects.toBeInstanceOf(OwnershipIndexConflictError);
  });
});

describe("fixture event source", () => {
  it("serves an asset's finalized events after a slot, and what they are complete through", async () => {
    const src = createFixtureEventSource(FIXTURE_EVENTS, 310_000_500n);
    expect(src.name).toBe("fixture");
    expect(await src.eventsAfter(share, null)).toEqual({ events: [shareEvents[0]], throughSlot: 310_000_500n });
    src.finalize(310_001_000n);
    expect(await src.eventsAfter(share, 310_000_500n)).toEqual({ events: [shareEvents[1]], throughSlot: 310_001_000n });
    expect((await src.eventsAfter(share, 310_001_000n)).events).toEqual([]);
  });
});
