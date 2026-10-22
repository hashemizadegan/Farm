/** Y9: an engine's result is checked against the ownership input it was given. */
import { describe, expect, it } from "vitest";
import type { WeightedOwnershipInput } from "@metafarm/domain";
import { engineOutputProblems, type YieldCalculationRequest, type YieldCalculationResult } from "./lib/yield-engine";

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const H = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const req = {
  ownership: { parties: [{ partyId: P1 }], unattributed: [{ holderKey: H }] } as unknown as WeightedOwnershipInput,
} as YieldCalculationRequest;
const out = (allocations: YieldCalculationResult["allocations"]) => ({ allocations }) as YieldCalculationResult;

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
});
