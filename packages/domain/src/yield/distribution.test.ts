import { describe, expect, it } from "vitest";
import { U64_MAX, type YieldAmountError } from "./amounts";
import {
  DISTRIBUTION_ENTRY_COMMANDS,
  DISTRIBUTION_ENTRY_STATES,
  DISTRIBUTION_ENTRY_TERMINAL_STATES,
  DISTRIBUTION_ENTRY_TRANSITIONS,
  type DistributionError,
  type DistributionLedger,
  type DistributionPolicy,
  type DistributionShare,
  SIMULATION_DISTRIBUTION_POLICY,
  canonicalDistributionPlan,
  distributionEntryTransition,
  distributionPlanHash,
  distributionPolicyProblems,
  emptyDistributionLedger,
  planDistribution,
} from "./distribution";
import { YieldRecordError } from "./records";

const sim = { id: "sim-cycle", version: 1, simulation: true };
const policy = (patch: Partial<DistributionPolicy> = {}): DistributionPolicy => ({ ...SIMULATION_DISTRIBUTION_POLICY, ...patch });
const party = (partyId: string, weight: bigint, payoutWallet: string | null = `wallet-${partyId}`): DistributionShare => ({ kind: "party", partyId, payoutWallet, weight });
const plan = (shares: DistributionShare[], ndy: bigint, p = policy(), ledger: DistributionLedger = emptyDistributionLedger(), cycle = sim) =>
  planDistribution({ cycle, policy: p, netDistributableYield: ndy, shares, ledger });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as DistributionError | YieldAmountError).code ?? (e as Error).name;
  }
  return "no error";
};

describe("distribution plan", () => {
  it("F: 1,000,000 base units over three equal parties → 333,334 / 333,333 / 333,333, all payable", () => {
    const p = plan([party("c", 1n), party("a", 1n), party("b", 1n)], 1_000_000n);
    expect(p.entries.map((e) => [e.partyId, e.amount, e.state])).toEqual([
      ["a", 333_334n, "payable"],
      ["b", 333_333n, "payable"],
      ["c", 333_333n, "payable"],
    ]);
    expect(p.totals).toEqual({ payable: 1_000_000n, deferred: 0n, withheld: 0n, unattributed: 0n, remainderCarried: 0n });
    expect(p.ledgerOut).toEqual({ carriedRemainder: 0n, deferred: [] });
  });

  it("carry rule: the remainder goes to the ledger and into the next cycle's total", () => {
    const p1 = plan([party("a", 1n), party("b", 1n), party("c", 1n)], 1_000_000n, policy({ remainder: "carry" }));
    expect(p1.totals.remainderCarried).toBe(1n);
    expect(p1.ledgerOut.carriedRemainder).toBe(1n);
    const p2 = plan([party("a", 1n), party("b", 1n), party("c", 1n)], 2n, policy({ remainder: "carry" }), p1.ledgerOut);
    expect(p2.entries.map((e) => e.amount)).toEqual([1n, 1n, 1n]);
    expect(p2.ledgerOut.carriedRemainder).toBe(0n);
  });

  it("dust stays with its party, accumulates across cycles, and becomes payable at the threshold", () => {
    const pol = policy({ dustThreshold: 10n });
    const shares = [party("big", 97n), party("small", 3n)];
    const p1 = plan(shares, 100n, pol);
    expect(p1.entries.find((e) => e.partyId === "small")).toMatchObject({ amount: 3n, state: "deferred" });
    expect(p1.ledgerOut.deferred).toEqual([{ partyId: "small", amount: 3n }]);
    const p2 = plan(shares, 100n, pol, p1.ledgerOut);
    expect(p2.entries.find((e) => e.partyId === "small")).toMatchObject({ allocated: 3n, deferredIn: 3n, amount: 6n, state: "deferred" });
    const p3 = plan(shares, 200n, pol, p2.ledgerOut);
    expect(p3.entries.find((e) => e.partyId === "small")).toMatchObject({ allocated: 6n, deferredIn: 6n, amount: 12n, state: "payable" });
    expect(p3.ledgerOut.deferred).toEqual([]);
  });

  it("carries deferred dust of a party that holds nothing this cycle, unchanged", () => {
    const p = plan([party("a", 1n)], 100n, policy(), { carriedRemainder: 0n, deferred: [{ partyId: "gone", amount: 4n }] });
    expect(p.ledgerOut.deferred).toEqual([{ partyId: "gone", amount: 4n }]);
    expect(p.totals.deferred).toBe(4n);
  });

  it("records unattributed shares without redistributing them", () => {
    const p = plan([party("a", 1n), { kind: "unattributed", holderKey: "acct-x", weight: 1n }], 10n);
    expect(p.entries.map((e) => [e.kind, e.amount, e.state])).toEqual([
      ["party", 5n, "payable"],
      ["unattributed", 5n, "unattributed"],
    ]);
    expect(p.totals.unattributed).toBe(5n);
  });

  it("missing payout wallet: withheld (recorded, not payable) or the whole cycle refused, as the policy says (D-14)", () => {
    const shares = [party("a", 1n), party("nowallet", 1n, null)];
    const withheld = plan(shares, 10n, policy({ missingPayoutWallet: "withhold" }));
    expect(withheld.entries.find((e) => e.partyId === "nowallet")).toMatchObject({ amount: 5n, state: "withheld" });
    expect(withheld.totals).toMatchObject({ payable: 5n, withheld: 5n });
    expect(code(() => plan(shares, 10n, policy({ missingPayoutWallet: "refuse_cycle" })))).toBe("missing_payout_wallet");
  });

  it("is independent of the order of shares and of deferred entries", async () => {
    const shares = [party("x", 3n), party("y", 5n), { kind: "unattributed", holderKey: "u1", weight: 7n } as const, party("z", 11n, null)];
    const ledger = { carriedRemainder: 2n, deferred: [{ partyId: "y", amount: 1n }, { partyId: "x", amount: 2n }] };
    const a = plan(shares, 1_000_003n, policy({ dustThreshold: 5n }), ledger);
    const b = plan([...shares].reverse(), 1_000_003n, policy({ dustThreshold: 5n }), { ...ledger, deferred: [...ledger.deferred].reverse() });
    expect(b).toEqual(a);
    expect(await distributionPlanHash(b)).toBe(await distributionPlanHash(a));
    expect(canonicalDistributionPlan(a)).toContain('"scheme":"metafarm-yield-distribution-plan/1"');
  });

  it("conserves exactly over 500 seeded random cases", () => {
    let seed = 0xd15;
    const r = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 500; i++) {
      const n = 1 + r(6);
      const shares: DistributionShare[] = Array.from({ length: n }, (_, j) =>
        r(5) === 0 ? { kind: "unattributed", holderKey: `h${j}`, weight: BigInt(r(1000)) } : party(`p${j}`, BigInt(r(1000)), r(6) === 0 ? null : `w${j}`),
      );
      if (shares.every((s) => s.weight === 0n)) shares[0] = { ...shares[0]!, weight: 1n };
      const ledger = { carriedRemainder: BigInt(r(50)), deferred: Array.from({ length: r(3) }, (_, j) => ({ partyId: `p${j + r(4)}x`, amount: BigInt(r(20)) })).filter((d, k, all) => all.findIndex((x) => x.partyId === d.partyId) === k) };
      const p = plan(shares, BigInt(r(1_000_000)), policy({ remainder: r(2) ? "carry" : "largest_remainder", dustThreshold: BigInt(r(30)) }), ledger);
      const inflow = p.netDistributableYield + ledger.carriedRemainder + ledger.deferred.reduce((s, d) => s + d.amount, 0n);
      const t = p.totals;
      expect(t.payable + t.deferred + t.withheld + t.unattributed + t.remainderCarried).toBe(inflow);
      for (const e of p.entries) expect(e.amount).toBe(e.allocated + e.deferredIn);
    }
  });

  it("refuses a payable amount that does not fit u64 (plan example G)", () => {
    expect(code(() => plan([party("a", 1n)], U64_MAX, policy(), { carriedRemainder: 0n, deferred: [{ partyId: "a", amount: 1n }] }))).toBe("amount_out_of_range");
    expect(plan([party("a", 1n)], U64_MAX).entries[0]!.amount).toBe(U64_MAX);
  });

  it("uses the simulation defaults only for simulation cycles; real cycles need an approved policy", () => {
    expect(code(() => plan([party("a", 1n)], 1n, policy(), emptyDistributionLedger(), { ...sim, simulation: false }))).toBe("YieldRecordError");
    expect(code(() => plan([party("a", 1n)], 1n, policy({ status: "draft" })))).toBe("YieldRecordError");
    expect(() => plan([party("a", 1n)], 1n, policy({ status: "approved" }), emptyDistributionLedger(), { ...sim, simulation: false })).not.toThrow();
    expect(() => plan([party("a", 1n)], 1n, policy({ status: "approved" }))).toThrow(YieldRecordError);
  });

  it("refuses invalid input instead of guessing", () => {
    expect(code(() => plan([], 1n))).toBe("invalid_input");
    expect(code(() => plan([party("a", 1n), party("a", 2n)], 1n))).toBe("invalid_input");
    expect(code(() => plan([party("a", 0n)], 1n))).toBe("invalid_parameter");
    expect(code(() => plan([party(" a", 1n)], 1n))).toBe("invalid_input");
    expect(code(() => plan([party("a", 1n, "")], 1n))).toBe("invalid_input");
    expect(code(() => plan([{ ...party("a", 1n), share: 1 } as never], 1n))).toBe("invalid_parameter");
    expect(code(() => plan([party("a", 1n)], -1n))).toBe("negative");
    expect(code(() => plan([party("a", 1n)], 1n, policy(), { carriedRemainder: 0n, deferred: [{ partyId: "a", amount: 1n }, { partyId: "a", amount: 2n }] }))).toBe("invalid_input");
    expect(code(() => planDistribution({ cycle: sim, policy: policy(), netDistributableYield: 1n, shares: [party("a", 1n)], ledger: emptyDistributionLedger(), extra: 1 } as never))).toBe("invalid_parameter");
    expect(distributionPolicyProblems({})).toHaveLength(6);
    expect(distributionPolicyProblems({ ...policy(), dustThreshold: 5 })).toEqual(["dustThreshold must be a bigint ≥ 0"]);
  });

  it("returns new objects: changing the plan does not change the ledger passed in", () => {
    const ledger = { carriedRemainder: 0n, deferred: [{ partyId: "a", amount: 1n }] };
    const p = plan([party("b", 1n)], 1n, policy(), ledger);
    p.ledgerIn.deferred[0]!.amount = 99n;
    expect(ledger.deferred[0]!.amount).toBe(1n);
  });
});

describe("distribution entry transition table", () => {
  it("allows exactly the listed transitions and refuses every other pair", () => {
    for (const from of DISTRIBUTION_ENTRY_STATES)
      for (const command of DISTRIBUTION_ENTRY_COMMANDS) {
        const row = DISTRIBUTION_ENTRY_TRANSITIONS.find((t) => t.from === from && t.command === command);
        const result = code(() => distributionEntryTransition(from, command));
        if (!row) expect(result, `${from} ${command}`).toBe("invalid_transition");
        else if (row.future) expect(result, `${from} ${command}`).toBe("future_phase");
        else expect(distributionEntryTransition(from, command)).toBe(row.to);
      }
  });

  it("has no exits from terminal states and no duplicate rows", () => {
    for (const s of DISTRIBUTION_ENTRY_TERMINAL_STATES) expect(DISTRIBUTION_ENTRY_TRANSITIONS.filter((t) => t.from === s)).toEqual([]);
    const pairs = DISTRIBUTION_ENTRY_TRANSITIONS.map((t) => `${t.from}/${t.command}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("refuses claim, expiry and release while their decisions are open; void and carry are allowed", () => {
    expect(code(() => distributionEntryTransition("payable", "claim"))).toBe("future_phase");
    expect(code(() => distributionEntryTransition("payable", "expire"))).toBe("future_phase");
    expect(code(() => distributionEntryTransition("withheld", "release"))).toBe("future_phase");
    expect(code(() => distributionEntryTransition("unattributed", "release"))).toBe("future_phase");
    expect(distributionEntryTransition("payable", "void")).toBe("voided");
    expect(distributionEntryTransition("deferred", "carry")).toBe("carried");
  });

  it("every non-terminal state the engine produces can be voided (supersession never strands an entry)", () => {
    for (const s of ["payable", "deferred", "withheld", "unattributed"] as const) expect(distributionEntryTransition(s, "void")).toBe("voided");
  });
});
