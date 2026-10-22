/** Y9: an engine's result is checked against the ownership input it was given. */
import { describe, expect, it } from "vitest";
import type { WeightedOwnershipInput } from "@metafarm/domain";
import { engineOutputProblems, type YieldCalculationRequest, type YieldCalculationResult } from "./lib/yield-engine";

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const H = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const req = {
  ownership: { parties: [{ partyId: P1 }], unattributed: [{ holderKey: H }] } as unknown as WeightedOwnershipInput,
  carryIn: { sha256: "c".repeat(64) },
} as YieldCalculationRequest;
const out = (allocations: YieldCalculationResult["allocations"], leaves: YieldCalculationResult["frozen"]["leaves"] = [], carryIn = "c".repeat(64)) =>
  ({ allocations, frozen: { leaves }, carry: { ledgerIn: { sha256: carryIn } } }) as unknown as YieldCalculationResult;
const leaf = (partyId: string, amount: bigint, leafIndex = 0) => ({ leafIndex, partyId, payoutWallet: "w".repeat(32), recipient: "0".repeat(64), amount, leafBytes: "", leafHash: "", path: [] });

describe("engine output check", () => {
  it("accepts recipients from the ownership input, once each, and one dust row", () => {
    expect(engineOutputProblems(req, out([{ kind: "allocated", partyId: P1, weight: 1n, amount: 5n }, { kind: "unattributed", holderKey: H, weight: 1n, amount: 1n }, { kind: "dust", weight: 0n, amount: 1n }]))).toEqual([]);
  });
  it("refuses invented, duplicated or negative entries", () => {
    expect(engineOutputProblems(req, out([{ kind: "allocated", partyId: P2, weight: 1n, amount: 1n }]))).toHaveLength(1);
    expect(engineOutputProblems(req, out([{ kind: "withheld", partyId: P1, weight: 1n, amount: 1n }, { kind: "allocated", partyId: P1, weight: 1n, amount: 1n }]))).toHaveLength(1);
    expect(engineOutputProblems(req, out([{ kind: "unattributed", holderKey: "other", weight: 1n, amount: 1n }]))).toHaveLength(1);
    expect(engineOutputProblems(req, out([{ kind: "dust", weight: 0n, amount: 1n }, { kind: "dust", weight: 0n, amount: 1n }]))).toHaveLength(1);
    expect(engineOutputProblems(req, out([{ kind: "allocated", partyId: P1, weight: 1n, amount: -1n }]))).toHaveLength(1);
  });

  it("refuses leaves that do not pay a party exactly its allocation, and a calculation that ignored the carry-in", () => {
    const alloc = [{ kind: "allocated" as const, partyId: P1, weight: 1n, amount: 5n }];
    expect(engineOutputProblems(req, out(alloc, [leaf(P1, 5n)]))).toEqual([]);
    expect(engineOutputProblems(req, out(alloc, [leaf(P1, 4n)]))).toHaveLength(1);
    expect(engineOutputProblems(req, out(alloc, [leaf(P2, 5n)]))).toHaveLength(1);
    expect(engineOutputProblems(req, out(alloc, [leaf(P1, 5n), leaf(P1, 5n, 1)]))).toHaveLength(1);
    expect(engineOutputProblems(req, out(alloc, [], "d".repeat(64)))).toEqual(["the calculation did not take the platform's carry-in"]);
  });
});
