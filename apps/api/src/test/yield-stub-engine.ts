/**
 * A deterministic stand-in for the yield calculation library, for API tests only. It is NOT the plan's waterfall
 * (Y2): net = revenue − expenses (floored at zero), split over the ownership weights, rounded down, the remainder
 * as dust. Integers only; hashes are SHA-256 over canonical JSON.
 */
import { createHash } from "node:crypto";
import type { YieldAllocationRecord } from "@metafarm/db";
import { EMPTY_CARRY_LEDGER, canonicalCarryLedger, carryLedgerHash } from "@metafarm/domain/yield";
import type { YieldCalculationEngine, YieldCalculationRequest, YieldCalculationResult } from "../lib/yield-engine";

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))).digest("hex");

export function stubYieldEngine(tamper?: (r: YieldCalculationResult) => YieldCalculationResult): YieldCalculationEngine & { calls: number } {
  const engine = {
    name: "test-stub",
    calls: 0,
    async calculate(req: YieldCalculationRequest): Promise<YieldCalculationResult> {
      engine.calls++;
      const sum = (side: string) => req.inputs.filter((i) => i.side === side).reduce((a, i) => a + i.amount, 0n);
      const net = sum("revenue") > sum("expense") ? sum("revenue") - sum("expense") : 0n;
      const total = req.ownership.totalWeight;
      const allocations: YieldAllocationRecord[] = [
        ...req.ownership.parties.map((p) => ({ kind: "allocated" as const, partyId: p.partyId, weight: p.weight, amount: (net * p.weight) / total })),
        ...req.ownership.unattributed.map((u) => ({ kind: "unattributed" as const, holderKey: u.holderKey, weight: u.weight, amount: (net * u.weight) / total })),
      ];
      const dust = net - allocations.reduce((a, x) => a + x.amount, 0n);
      if (dust > 0n) allocations.push({ kind: "dust", weight: 0n, amount: dust });
      const calculationHash = sha({ cycle: req.cycle.id, net, ownership: req.ownership.commitment });
      const allocationHash = sha(allocations);
      const evidenceBundleHash = sha(req.inputs.map((i) => [i.sourceKind, i.sourceRef, i.evidenceId]));
      const merkleRoot = sha({ leaves: allocations });
      // The frozen "artifact" of the stub is its own hashes as canonical text; the set hash is that text's SHA-256.
      const body = JSON.stringify({ calculationHash, allocationHash, evidenceBundleHash, merkleRoot, scheme: "test-stub-artifact/1" });
      const setHash = createHash("sha256").update(body).digest("hex");
      const out = {
        calculationHash,
        allocationHash,
        evidenceBundleHash,
        merkleRoot,
        setHash,
        allocations,
        totals: { net: net.toString() },
        frozen: { scheme: "test-stub-artifact/1", body, hasherId: "test-stub", leaves: [] },
        carry: { ledgerIn: { body: canonicalCarryLedger(req.carryIn.ledger), sha256: req.carryIn.sha256 }, ledgerOut: { body: canonicalCarryLedger(EMPTY_CARRY_LEDGER), sha256: await carryLedgerHash(EMPTY_CARRY_LEDGER) } },
      };
      return tamper ? tamper(out) : out;
    },
  };
  return engine;
}
