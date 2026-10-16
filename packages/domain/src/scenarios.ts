/**
 * Crop and income scenarios.
 *
 * Scenarios are what-if calculations driven entirely by numbers the user
 * enters. The application ships NO default yields, prices or costs: we do not
 * have authoritative agronomic or market data, and inventing it would mislead.
 *
 * Every result is labelled `simulated` and carries a disclaimer. Results are
 * never stored or displayed as realised income.
 */

export interface ScenarioRange {
  low: number;
  base: number;
  high: number;
}

export interface CropScenarioInput {
  cropName: string;
  /** Planted area in hectares. Defaults to the boundary area when omitted. */
  plantedAreaHa: number;
  /** User-entered expected yield per hectare, in `yieldUnit`. */
  yieldPerHa: ScenarioRange;
  yieldUnit: string;
  /** User-entered price per `yieldUnit`, in `currency`. */
  pricePerUnit: ScenarioRange;
  /** User-entered total costs for the season, in `currency`. */
  costs: ScenarioRange;
  currency: string;
  /** Free-text note on where the user's numbers came from. */
  assumptionsNote?: string;
}

export interface ScenarioCaseResult {
  production: number;
  grossRevenue: number;
  costs: number;
  net: number;
}

export interface CropScenarioResult {
  kind: "simulated";
  provenance: "user-entered";
  disclaimer: string;
  currency: string;
  yieldUnit: string;
  cases: { low: ScenarioCaseResult; base: ScenarioCaseResult; high: ScenarioCaseResult };
}

export const SCENARIO_DISCLAIMER =
  "Simulated scenario based only on figures you entered. It is not a forecast, not realised income, " +
  "and not an offer or promise of any return. Actual results depend on factors this application does not model.";

export class ScenarioInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioInputError";
  }
}

function assertRange(name: string, r: ScenarioRange) {
  for (const [k, v] of Object.entries(r)) {
    if (!Number.isFinite(v) || v < 0) throw new ScenarioInputError(`${name}.${k} must be a non-negative number`);
  }
  if (!(r.low <= r.base && r.base <= r.high)) {
    throw new ScenarioInputError(`${name} must satisfy low ≤ base ≤ high`);
  }
}

export function runCropScenario(input: CropScenarioInput): CropScenarioResult {
  if (!input.cropName.trim()) throw new ScenarioInputError("cropName is required");
  if (!Number.isFinite(input.plantedAreaHa) || input.plantedAreaHa <= 0) {
    throw new ScenarioInputError("plantedAreaHa must be positive");
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new ScenarioInputError("currency must be an ISO 4217 code");
  assertRange("yieldPerHa", input.yieldPerHa);
  assertRange("pricePerUnit", input.pricePerUnit);
  assertRange("costs", input.costs);

  // Low case pairs low yield and low price with HIGH costs (and vice versa) so
  // the range brackets the user's own pessimistic and optimistic assumptions.
  const compute = (y: number, p: number, c: number): ScenarioCaseResult => {
    const production = round2(input.plantedAreaHa * y);
    const grossRevenue = round2(production * p);
    return { production, grossRevenue, costs: round2(c), net: round2(grossRevenue - c) };
  };

  return {
    kind: "simulated",
    provenance: "user-entered",
    disclaimer: SCENARIO_DISCLAIMER,
    currency: input.currency,
    yieldUnit: input.yieldUnit,
    cases: {
      low: compute(input.yieldPerHa.low, input.pricePerUnit.low, input.costs.high),
      base: compute(input.yieldPerHa.base, input.pricePerUnit.base, input.costs.base),
      high: compute(input.yieldPerHa.high, input.pricePerUnit.high, input.costs.low),
    },
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export const M2_PER_HA = 10_000;
export function m2ToHa(m2: number) {
  return m2 / M2_PER_HA;
}
