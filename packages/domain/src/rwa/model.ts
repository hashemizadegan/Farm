/**
 * Real-world asset (RWA) model: canonical farm assets, their on-chain representations, and the
 * financial intents that act on them. Chain-agnostic: no blockchain SDK is imported anywhere in
 * the domain. Solana and TRON are independent rails, linked only by internal reconciliation ids.
 */
import { z } from "zod";

/** What a business asset is. Spatial assets point at surveyed geometry, never at the illustrative 3D scene. */
export const ASSET_KINDS = ["parcel", "tree", "livestock", "equipment", "harvest_lot", "farm_share"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_STATUSES = ["draft", "verified", "active", "suspended", "retired"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const RAILS = ["SOLANA_TOKEN_2022", "SOLANA_BUBBLEGUM_CNFT", "TRON_TRC20"] as const;
export type Rail = (typeof RAILS)[number];

export const NETWORKS = ["solana-devnet", "solana-mainnet", "tron-nile", "tron-shasta", "tron-mainnet"] as const;
export type Network = (typeof NETWORKS)[number];

export const RAIL_NETWORKS: Record<Rail, readonly Network[]> = {
  SOLANA_TOKEN_2022: ["solana-devnet", "solana-mainnet"],
  SOLANA_BUBBLEGUM_CNFT: ["solana-devnet", "solana-mainnet"],
  TRON_TRC20: ["tron-nile", "tron-shasta", "tron-mainnet"],
};

export const MAINNETS: readonly Network[] = ["solana-mainnet", "tron-mainnet"];

export const REPRESENTATION_STATUSES = ["planned", "issuing", "active", "frozen", "retired"] as const;
export type RepresentationStatus = (typeof REPRESENTATION_STATUSES)[number];

/** Actions on an asset representation (Solana side). */
export const ISSUANCE_ACTIONS = ["mint", "burn", "freeze", "thaw"] as const;
export type IssuanceAction = (typeof ISSUANCE_ACTIONS)[number];

/** Why money moves on the settlement rail (TRON side). */
export const SETTLEMENT_PURPOSES = ["subscription", "distribution", "redemption", "fee", "refund"] as const;
export type SettlementPurpose = (typeof SETTLEMENT_PURPOSES)[number];

/** A business request, independent of how many chain attempts it takes. */
export const INTENT_STATUSES = ["requested", "policy_rejected", "approved", "in_progress", "completed", "failed", "cancelled"] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export const RECONCILIATION_KINDS = ["amount_mismatch", "missing_settlement", "missing_issuance", "duplicate", "orphan_chain_tx", "stale"] as const;
export type ReconciliationKind = (typeof RECONCILIATION_KINDS)[number];

export const RECONCILIATION_STATUSES = ["open", "investigating", "resolved", "written_off"] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/** Token amounts in base units (lamport-style integers), as text so no precision is lost. Up to 2^256. */
export const baseUnits = z.string().regex(/^(0|[1-9]\d{0,77})$/, "a whole number of base units");

export function railOf(network: Network): "solana" | "tron" {
  return network.startsWith("solana-") ? "solana" : "tron";
}

/**
 * Whether operations may run on a network. Mainnets stay closed until the workspace's legal and
 * compliance sign-off turns them on (RWA_MAINNET_ENABLED); testnets are always allowed.
 */
export function networkAllowed(network: Network, o: { mainnetEnabled: boolean }): boolean {
  return !MAINNETS.includes(network) || o.mainnetEnabled;
}

export function representationValid(rail: Rail, network: Network): boolean {
  return RAIL_NETWORKS[rail].includes(network);
}
