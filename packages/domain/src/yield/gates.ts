/**
 * What each step needs before it may proceed for a real (non-simulation) cycle. Plan revision 4, §2.1
 * ("Non-simulation cycles fail closed"). This module only *reports* requirements; it decides nothing that
 * the plan leaves open.
 *
 * Simulation cycles have no entries here: they use simulation-labelled records (see records.ts) and are
 * never legally effective.
 */

/** Requirements, each named with the plan decision that must be approved to satisfy it. */
export const YIELD_REQUIREMENTS = {
  evidence_storage: "D-24",
  entitlement_instrument: "D-1",
  calculation_policy: "D-2..D-10, D-21",
  settlement_unit: "D-3",
  asset_class: "D-20",
  compressed_nft_scope: "D-18",
  equipment_linkage: "D-19",
  holding_model: "D-12",
  verified_ownership_source: "D-16",
  /**
   * An approved payout wallet for every allocated party. What happens when a party has none (refuse the
   * cycle, or withhold that party's amount without a leaf) is an open question (plan §13.2, question 2);
   * this module only reports the requirement as unmet.
   */
  payout_wallets: "D-14",
  attestation_quorum: "D-23",
  dispute_authority: "D-22",
  public_exposure: "D-30",
} as const;
export type YieldRequirement = keyof typeof YIELD_REQUIREMENTS;

export const YIELD_GATED_STEPS = ["register_evidence", "lock", "calculate", "approve", "publish"] as const;
export type YieldGatedStep = (typeof YIELD_GATED_STEPS)[number];

export interface YieldGateContext {
  simulation: boolean;
  /** The cycle covers one compressed NFT. */
  compressedNft: boolean;
  /** The cycle's asset class is equipment. */
  equipment: boolean;
  /** The public summary route is enabled for this cycle. */
  publicSummary: boolean;
}

export class YieldGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YieldGateError";
  }
}

function assertContext(ctx: YieldGateContext): void {
  for (const k of ["simulation", "compressedNft", "equipment", "publicSummary"] as const) {
    if (typeof ctx?.[k] !== "boolean") throw new YieldGateError(`the gate context must state ${k} explicitly`);
  }
}

/** The requirements a step has for this cycle. Empty for simulation cycles. */
export function yieldGateRequirements(step: YieldGatedStep, ctx: YieldGateContext): YieldRequirement[] {
  assertContext(ctx);
  if (!(YIELD_GATED_STEPS as readonly string[]).includes(step)) throw new YieldGateError(`unknown step ${String(step)}`);
  if (ctx.simulation) return [];
  switch (step) {
    case "register_evidence":
      return ["evidence_storage"];
    case "lock":
      return [
        "entitlement_instrument",
        "calculation_policy",
        "settlement_unit",
        "asset_class",
        ...(ctx.compressedNft ? (["compressed_nft_scope"] as const) : []),
        ...(ctx.equipment ? (["equipment_linkage"] as const) : []),
      ];
    case "calculate":
      return ["holding_model", "verified_ownership_source", "payout_wallets"];
    case "approve":
      return ["attestation_quorum"];
    case "publish":
      return ["dispute_authority", ...(ctx.publicSummary ? (["public_exposure"] as const) : [])];
  }
}

/** Requirements of the step that `satisfied` does not cover. Empty means the step may proceed. */
export function unmetYieldGateRequirements(step: YieldGatedStep, ctx: YieldGateContext, satisfied: ReadonlySet<YieldRequirement>): YieldRequirement[] {
  return yieldGateRequirements(step, ctx).filter((r) => !satisfied.has(r));
}
