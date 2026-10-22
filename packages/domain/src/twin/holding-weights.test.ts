import { describe, expect, it } from "vitest";
import {
  HOLDING_WEIGHT_ERROR_CODES,
  type HoldingWeightError,
  MAX_SLOT_SPAN,
  type OwnershipHistory,
  WEIGHT_MAX,
  buildWeightedOwnershipInput,
  slotWeightedHoldings,
  weightedOwnershipProblems,
} from "./holding-weights";
import type { ChainAssetRef, OwnershipEvent } from "./ownership";

const asset: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: "Mint1111111111111111111111111111111111111111" };
const U64_MAX = 2n ** 64n - 1n;
let n = 0;
const ev = (kind: OwnershipEvent["kind"], from: string | null, to: string | null, amount: bigint, slot: bigint, txIndex = 0, a: ChainAssetRef = asset): OwnershipEvent => ({
  asset: a,
  kind,
  from,
  to,
  amount,
  slot,
  txIndex,
  ixIndex: 0,
  signature: `sig${String(++n).padStart(4, "0")}`,
});
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as HoldingWeightError).code ?? (e as Error).name;
  }
  return "no error";
};
const acode = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (e) {
    return (e as HoldingWeightError).code ?? (e as Error).name;
  }
  return "no error";
};

/** Slot-by-slot reference: the balance after each slot's events, summed over (start, end]. */
function reference(events: OwnershipEvent[], start: bigint, end: bigint): Map<string, bigint> {
  const sorted = [...events].filter((e) => e.slot <= end).sort((a, b) => (a.slot !== b.slot ? (a.slot < b.slot ? -1 : 1) : a.txIndex - b.txIndex));
  const bal = new Map<string, bigint>();
  const w = new Map<string, bigint>();
  let i = 0;
  for (let s = 0n; s <= end; s++) {
    while (i < sorted.length && sorted[i]!.slot === s) {
      const e = sorted[i++]!;
      if (e.from) bal.set(e.from, (bal.get(e.from) ?? 0n) - e.amount);
      if (e.to) bal.set(e.to, (bal.get(e.to) ?? 0n) + e.amount);
    }
    if (s > start) for (const [o, b] of bal) if (b > 0n) w.set(o, (w.get(o) ?? 0n) + b);
  }
  return w;
}

describe("slotWeightedHoldings (D-12: slots)", () => {
  it("weights each owner by units × slots held in (start, end], the balance after a slot's events counting for that slot", () => {
    const events = [ev("mint", null, "A", 1_000n, 50n), ev("transfer", "A", "B", 400n, 150n)];
    const r = slotWeightedHoldings(asset, events, { startSlot: 100n, endSlot: 200n });
    // A: slots 101–149 at 1,000 (49) + slots 150–200 at 600 (51) = 79,600. B: 51 × 400 = 20,400.
    expect(r.owners).toEqual([
      { owner: "A", weight: 79_600n, pointInTimeUnits: 600n },
      { owner: "B", weight: 20_400n, pointInTimeUnits: 400n },
    ]);
    expect([r.totalWeight, r.pointInTimeTotal]).toEqual([100_000n, 1_000n]); // supply × span when supply is constant
  });

  it("handles events at the window edges, inside it and after it", () => {
    const events = [ev("mint", null, "A", 10n, 100n), ev("transfer", "A", "B", 10n, 101n), ev("mint", null, "C", 5n, 110n), ev("burn", "C", null, 5n, 110n, 1), ev("transfer", "B", "D", 10n, 120n), ev("transfer", "D", "E", 10n, 121n)];
    const r = slotWeightedHoldings(asset, events, { startSlot: 100n, endSlot: 120n });
    // A held 10 only at slot 100 (the start, not counted). B: 101–119 (19 slots) × 10. C minted and burned in slot 110: 0.
    // D receives at the end slot: counts 1 slot. The transfer at 121 is after the window.
    expect(r.owners).toEqual([
      { owner: "B", weight: 190n, pointInTimeUnits: 0n },
      { owner: "D", weight: 10n, pointInTimeUnits: 10n },
    ]);
    expect(r.eventsUsed.map((e) => e.slot)).toEqual([100n, 101n, 110n, 110n, 120n]);
  });

  it("matches a slot-by-slot reference on seeded random histories, independent of input order", () => {
    let seed = 7;
    const rnd = (k: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % k);
    for (let round = 0; round < 40; round++) {
      const owners = ["A", "B", "C", "D", "E"];
      const bal = new Map<string, bigint>([["A", 0n]]);
      const events: OwnershipEvent[] = [ev("mint", null, "A", BigInt(1 + rnd(1_000)), BigInt(rnd(20)))];
      bal.set("A", events[0]!.amount);
      let slot = events[0]!.slot;
      for (let k = 0; k < 25; k++) {
        slot += BigInt(rnd(6));
        const holders = [...bal].filter(([, b]) => b > 0n);
        const choice = rnd(10);
        if (choice === 0 || holders.length === 0) {
          const to = owners[rnd(5)]!;
          const amt = BigInt(1 + rnd(500));
          events.push(ev("mint", null, to, amt, slot, k + 1));
          bal.set(to, (bal.get(to) ?? 0n) + amt);
        } else {
          const [from, b] = holders[rnd(holders.length)]!;
          const amt = BigInt(1 + rnd(Number(b)));
          if (choice === 1) {
            events.push(ev("burn", from, null, amt, slot, k + 1));
            bal.set(from, b - amt);
          } else {
            const to = owners[rnd(5)]!;
            events.push(ev("transfer", from, to, amt, slot, k + 1));
            bal.set(from, b - amt);
            bal.set(to, (bal.get(to) ?? 0n) + amt);
          }
        }
      }
      const start = BigInt(rnd(30));
      const end = start + 1n + BigInt(rnd(80));
      const want = reference(events, start, end);
      const total = [...want.values()].reduce((a, b) => a + b, 0n);
      if (total === 0n) {
        expect(code(() => slotWeightedHoldings(asset, events, { startSlot: start, endSlot: end }))).toBe("no_holdings");
        continue;
      }
      const r = slotWeightedHoldings(asset, events, { startSlot: start, endSlot: end });
      expect(new Map(r.owners.filter((o) => o.weight > 0n).map((o) => [o.owner, o.weight]))).toEqual(new Map([...want].filter(([, w]) => w > 0n)));
      expect(r.totalWeight).toBe(total);
      expect(slotWeightedHoldings(asset, [...events].reverse(), { startSlot: start, endSlot: end })).toEqual(r);
    }
  });

  it("counts an identical replay once and refuses a conflicting one", () => {
    const mint = ev("mint", null, "A", 10n, 1n);
    const r = slotWeightedHoldings(asset, [mint, { ...mint }], { startSlot: 0n, endSlot: 10n });
    expect(r.owners).toEqual([{ owner: "A", weight: 100n, pointInTimeUnits: 10n }]);
    expect(r.eventsUsed).toHaveLength(1);
    expect(code(() => slotWeightedHoldings(asset, [mint, { ...mint, amount: 11n }], { startSlot: 0n, endSlot: 10n }))).toBe("ownership_conflict");
    expect(code(() => slotWeightedHoldings(asset, [mint, ev("transfer", "A", "B", 11n, 2n)], { startSlot: 0n, endSlot: 10n }))).toBe("ownership_conflict");
    // A conflict after endSlot is outside the window and does not matter.
    expect(code(() => slotWeightedHoldings(asset, [mint, ev("transfer", "A", "B", 11n, 20n)], { startSlot: 0n, endSlot: 10n }))).toBe("no error");
  });

  it("refuses foreign events, malformed values, bad windows and an empty window", () => {
    const other: ChainAssetRef = { ...asset, id: "Other111111111111111111111111111111111111111" };
    expect(code(() => slotWeightedHoldings(asset, [ev("mint", null, "A", 1n, 1n, 0, other)], { startSlot: 0n, endSlot: 2n }))).toBe("foreign_event");
    expect(code(() => slotWeightedHoldings(asset, [{ ...ev("mint", null, "A", 1n, 1n), asset: { ...asset, network: "solana-mainnet" } }], { startSlot: 0n, endSlot: 2n }))).toBe("foreign_event");
    expect(code(() => slotWeightedHoldings(asset, [{ ...ev("mint", null, "A", 1n, 1n), amount: 1 as never }], { startSlot: 0n, endSlot: 2n }))).toBe("invalid_input");
    expect(code(() => slotWeightedHoldings(asset, [ev("mint", null, "A", U64_MAX + 1n, 1n)], { startSlot: 0n, endSlot: 2n }))).toBe("invalid_input");
    expect(code(() => slotWeightedHoldings(asset, [ev("mint", null, "A", 0n, 1n)], { startSlot: 0n, endSlot: 2n }))).toBe("ownership_conflict"); // zero amounts are invalid events
    for (const w of [{ startSlot: 5n, endSlot: 5n }, { startSlot: 6n, endSlot: 5n }, { startSlot: -1n, endSlot: 5n }, { startSlot: 0n, endSlot: MAX_SLOT_SPAN + 1n }, { startSlot: 0n, endSlot: U64_MAX + 1n }, { startSlot: 0, endSlot: 5n } as never])
      expect(code(() => slotWeightedHoldings(asset, [ev("mint", null, "A", 1n, 1n)], w)), JSON.stringify(w, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))).toBe("invalid_window");
    expect(code(() => slotWeightedHoldings(asset, [ev("mint", null, "A", 1n, 1n), ev("burn", "A", null, 1n, 1n, 1)], { startSlot: 0n, endSlot: 10n }))).toBe("no_holdings");
    expect(code(() => slotWeightedHoldings(asset, [], { startSlot: 0n, endSlot: 10n }))).toBe("no_holdings");
  });

  it("is exact at the bounds: u64 amounts over the largest window stay below u128", () => {
    const r = slotWeightedHoldings(asset, [ev("mint", null, "A", U64_MAX, 0n)], { startSlot: 0n, endSlot: MAX_SLOT_SPAN });
    expect(r.totalWeight).toBe(U64_MAX * MAX_SLOT_SPAN);
    expect(r.totalWeight > U64_MAX).toBe(true); // why weights are not 64-bit shares
    expect(r.totalWeight < WEIGHT_MAX).toBe(true);
    // Two u64 holders over the largest window: still exact.
    const two = slotWeightedHoldings(asset, [ev("mint", null, "A", U64_MAX, 0n), ev("mint", null, "B", U64_MAX, 0n, 1)], { startSlot: 0n, endSlot: MAX_SLOT_SPAN });
    expect(two.totalWeight).toBe(2n * U64_MAX * MAX_SLOT_SPAN);
  });
});

describe("buildWeightedOwnershipInput (D-17 service layer)", () => {
  const identity = { id: "7", network: "solana-devnet", genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" };
  const events = [ev("mint", null, "W1", 600n, 10n), ev("mint", null, "W2", 300n, 10n, 1), ev("mint", null, "PLAYER", 100n, 10n, 2), ev("transfer", "W1", "W3", 100n, 150n)];
  const history = (patch: Partial<OwnershipHistory["provenance"]> = {}): OwnershipHistory => ({ asset, events, provenance: { sourceKind: "rpc", sourceIdentity: identity, cursorSlot: 300n, ...patch } });
  const partyOfWallet = new Map([
    ["W1", "party-a"],
    ["W3", "party-a"],
    ["W2", "party-b"],
  ]);
  const window = { startSlot: 100n, endSlot: 200n };

  it("sums weights per party over its wallets; addresses with no party (e.g. player wallets) are unattributed", async () => {
    const i = await buildWeightedOwnershipInput({ history: history(), window, partyOfWallet, simulation: false });
    expect(i.parties).toEqual([
      { partyId: "party-a", wallets: ["W1", "W3"], weight: 60_000n, pointInTimeUnits: 600n },
      { partyId: "party-b", wallets: ["W2"], weight: 30_000n, pointInTimeUnits: 300n },
    ]);
    expect(i.unattributed).toEqual([{ holderKey: "PLAYER", weight: 10_000n, pointInTimeUnits: 100n }]);
    expect([i.totalWeight, i.pointInTimeTotal]).toEqual([100_000n, 1_000n]);
    expect(i.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(i) && Object.isFrozen(i.parties[0]) && Object.isFrozen(i.parties[0]!.wallets)).toBe(true);
    expect(await weightedOwnershipProblems(i)).toEqual([]);
  });

  it("is deterministic: the same history in any order gives the same commitment", async () => {
    const a = await buildWeightedOwnershipInput({ history: history(), window, partyOfWallet, simulation: false });
    const b = await buildWeightedOwnershipInput({ history: { ...history(), events: [...events].reverse() }, window, partyOfWallet, simulation: false });
    expect(b.commitment).toBe(a.commitment);
    expect(b.eventsSha256).toBe(a.eventsSha256);
    const c = await buildWeightedOwnershipInput({ history: history(), window: { startSlot: 100n, endSlot: 201n }, partyOfWallet, simulation: false });
    expect(c.commitment).not.toBe(a.commitment);
  });

  it("D-17: fixture history is for simulation only; RPC history must be verified; history must reach endSlot", async () => {
    const fixture = history({ sourceKind: "fixture", sourceIdentity: null });
    expect(await acode(() => buildWeightedOwnershipInput({ history: fixture, window, partyOfWallet, simulation: false }))).toBe("fixture_in_real_cycle");
    const sim = await buildWeightedOwnershipInput({ history: fixture, window, partyOfWallet, simulation: true });
    expect([sim.simulation, sim.provenance.sourceKind]).toEqual([true, "fixture"]);
    expect(await acode(() => buildWeightedOwnershipInput({ history: history({ sourceIdentity: null }), window, partyOfWallet, simulation: true }))).toBe("unverified_source");
    expect(await acode(() => buildWeightedOwnershipInput({ history: history({ sourceIdentity: { ...identity, network: "solana-mainnet" } }), window, partyOfWallet, simulation: false }))).toBe("unverified_source");
    expect(await acode(() => buildWeightedOwnershipInput({ history: history({ sourceKind: "fixture" }), window, partyOfWallet, simulation: true }))).toBe("invalid_input");
    expect(await acode(() => buildWeightedOwnershipInput({ history: history({ cursorSlot: 199n }), window, partyOfWallet, simulation: false }))).toBe("incomplete_history");
    expect(await acode(() => buildWeightedOwnershipInput({ history: history(), window, partyOfWallet, simulation: undefined as never }))).toBe("invalid_input");
  });

  it("re-checking detects tampering: weights, totals, order, provenance and the commitment", async () => {
    const i = await buildWeightedOwnershipInput({ history: history(), window, partyOfWallet, simulation: false });
    const t = structuredClone(i);
    t.parties[0]!.weight += 1n;
    expect(await weightedOwnershipProblems(t)).toContain("totalWeight is not the sum of the weights");
    t.totalWeight += 1n;
    expect(await weightedOwnershipProblems(t)).toEqual(["the input does not hash to its commitment"]);
    const fixture = structuredClone(i);
    fixture.provenance = { ...fixture.provenance, sourceKind: "fixture", sourceIdentity: null };
    expect(await weightedOwnershipProblems(fixture)).toContain("a non-simulation input can only use verified RPC history (D-17)");
    const swapped = structuredClone(i);
    swapped.parties.reverse();
    expect(await weightedOwnershipProblems(swapped)).toContain("parties are not in canonical order");
    expect(await weightedOwnershipProblems({} as never)).toEqual(["not a weighted ownership input"]);
  });

  it("has a fixed set of error codes", () => {
    expect(HOLDING_WEIGHT_ERROR_CODES).toEqual(["not_indexed", "invalid_window", "invalid_input", "foreign_event", "ownership_conflict", "incomplete_history", "unverified_source", "fixture_in_real_cycle", "no_holdings", "duplicate_wallet", "weight_out_of_range"]);
  });
});
