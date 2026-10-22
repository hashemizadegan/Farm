/**
 * Y9: the calculation port of the yield workflow. `calculate` and `preview` hand a cycle's locked inputs and its
 * slot-weighted ownership input (Y5) to an engine and get back the frozen artifact-set hashes and the allocations.
 *
 * The engine is the yield domain's calculation library (Y2 waterfall, Y6 leaves and tree), which lives on the
 * yield branch line. This line never mixes it in: until the lines are integrated (an owner decision), the API has
 * no engine and `calculate` / `preview` answer 503 `calculation_engine_unavailable` (fail closed). Tests inject a
 * deterministic stub.
 *
 * Engine contract: pure and deterministic (same request, same result); integers only; never contacts a chain.
 */
import type { YieldAllocationRecord, YieldCycleRow, YieldInputRow } from "@metafarm/db";
import type { WeightedOwnershipInput } from "@metafarm/domain";
import type { SimulationDossier } from "@metafarm/domain/yield";

export interface YieldCalculationRequest {
  cycle: YieldCycleRow;
  inputs: readonly YieldInputRow[];
  ownership: WeightedOwnershipInput;
  /** The cycle's simulation dossier (latest registered while in draft), or null when none was registered. */
  dossier: SimulationDossier | null;
  /** The SHA-256 of each input line's evidence (by input id), or null for a line without evidence. */
  evidenceSha256ByInput: Readonly<Record<string, string | null>>;
}

/** An engine refusal with a stable code; nothing is stored. */
export class YieldEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 409 | 422 = 422,
  ) {
    super(message);
    this.name = "YieldEngineError";
  }
}

export interface YieldCalculationResult {
  calculationHash: string;
  allocationHash: string;
  evidenceBundleHash: string;
  merkleRoot: string;
  /** The hash attested to and approved (over the four hashes above). */
  setHash: string;
  allocations: YieldAllocationRecord[];
  /** Totals for display (decimal strings, accounting minor units); not stored. */
  totals: Record<string, string>;
}

export interface YieldCalculationEngine {
  readonly name: string;
  calculate(request: YieldCalculationRequest): Promise<YieldCalculationResult>;
}

/**
 * Refuses an engine result that does not belong to the request: a recipient that is not in the ownership input,
 * a duplicate recipient, or a negative amount. The database checks the rest (u64, one row per recipient).
 */
export function engineOutputProblems(req: YieldCalculationRequest, out: YieldCalculationResult): string[] {
  const problems: string[] = [];
  const parties = new Set(req.ownership.parties.map((p) => p.partyId));
  const holders = new Set(req.ownership.unattributed.map((u) => u.holderKey));
  const seen = new Set<string>();
  let dust = 0;
  for (const a of out.allocations) {
    if (a.amount < 0n || a.weight < 0n) problems.push("negative amount or weight");
    if (a.kind === "allocated" || a.kind === "withheld") {
      if (!a.partyId || !parties.has(a.partyId)) problems.push(`party ${a.partyId ?? "(none)"} is not in the ownership input`);
      else if (seen.has(`p:${a.partyId}`)) problems.push(`party ${a.partyId} appears twice`);
      else seen.add(`p:${a.partyId}`);
    } else if (a.kind === "unattributed") {
      if (!a.holderKey || !holders.has(a.holderKey)) problems.push(`holder ${a.holderKey ?? "(none)"} is not in the ownership input`);
      else if (seen.has(`h:${a.holderKey}`)) problems.push(`holder ${a.holderKey} appears twice`);
      else seen.add(`h:${a.holderKey}`);
    } else if (++dust > 1) problems.push("more than one dust row");
  }
  return problems;
}
