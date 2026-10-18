/**
 * Ports between the RWA domain and the chains. Adapters (packages/chain) implement them; nothing
 * here depends on a blockchain SDK. Amounts are base units as bigint; addresses are the rail's
 * own text form (base58 on Solana, base58check on TRON).
 */
import type { IssuanceAction, Network } from "./model";

/** Signs Solana transaction messages (ed25519). Backed by a KMS/HSM in production. */
export interface Ed25519Signer {
  readonly address: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/** Signs TRON transaction ids (secp256k1, 65-byte r‖s‖v hex). Backed by a KMS/HSM in production. */
export interface TronSigner {
  readonly address: string;
  signTransactionId(txIdHex: string): Promise<string>;
}

/** A signed transaction ready to send, and what is needed to follow it. */
export interface PreparedTransaction {
  network: Network;
  /** Solana signature (base58) or TRON transaction id (hex). */
  txRef: string;
  /** Signed transaction: base64 wire format (Solana) or JSON (TRON). */
  wire: string;
  /** When it can no longer land. */
  validity: { lastValidBlockHeight?: bigint; expiresAt?: Date };
  fees: { priorityFeeMicroLamports?: bigint; computeUnitLimit?: number; feeLimitSun?: bigint; estimatedEnergy?: bigint; estimatedBandwidth?: bigint };
  /** Human-readable summary for the audit trail (no secrets). */
  summary: Record<string, unknown>;
}

export interface TransferFeeConfig {
  /** 1/100 of a percent, 0–10 000. */
  basisPoints: number;
  maximumFee: bigint;
  configAuthority: string;
  withdrawAuthority: string;
}

export interface CreateMintRequest {
  network: Network;
  decimals: number;
  mintAuthority: string;
  freezeAuthority: string | null;
  transferFee?: TransferFeeConfig;
  /** Program that must approve every transfer (e.g. a compliance allow-list check). */
  transferHookProgramId?: string;
  transferHookAuthority?: string;
  /** May move or burn any holder's tokens: needed for court-ordered recovery or redemption. */
  permanentDelegate?: string;
}

export interface IssuanceRequest {
  network: Network;
  action: IssuanceAction;
  mintAddress: string;
  decimals: number;
  holderAddress: string;
  /** Required for mint and burn. */
  amount?: bigint;
}

/** Fungible fractional shares (Solana Token-2022). */
export interface AssetIssuancePort {
  prepareCreateMint(request: CreateMintRequest): Promise<PreparedTransaction & { mintAddress: string }>;
  prepareIssuance(request: IssuanceRequest): Promise<PreparedTransaction>;
}

export type ObservedStatus = "not_found" | "pending" | "observed" | "final" | "failed" | "expired";

export interface ChainObservation {
  status: ObservedStatus;
  slotOrBlock?: bigint;
  confirmations?: number;
  error?: string;
  feePaid?: bigint;
}

/** Sends prepared transactions and reports what the chain says about them. */
export interface ChainObservationPort {
  /** Sends (or re-sends: the same signed bytes, so it can never land twice). */
  submit(prepared: PreparedTransaction): Promise<void>;
  observe(target: { network: Network; txRef: string; lastValidBlockHeight?: bigint; expiresAt?: Date }): Promise<ChainObservation>;
}

export interface SettlementTransfer {
  network: Network;
  tokenContract: string;
  from: string;
  to: string;
  amount: bigint;
}

/** Stablecoin settlement on TRON (TRC-20). */
export interface SettlementPort {
  prepareTransfer(transfer: SettlementTransfer): Promise<PreparedTransaction>;
}

export interface CompressedAssetRecord {
  id: string;
  owner: string;
  tree: string;
  leafIndex: number;
  compressed: boolean;
  burnt: boolean;
  frozen: boolean;
}

export interface CompressedAssetProof {
  root: string;
  proof: string[];
  leaf: string;
  nodeIndex: number;
  tree: string;
}

/** One-of-a-kind micro-assets (trees, parcels, animals) as Bubblegum compressed NFTs, read through DAS. */
export interface CompressedAssetPort {
  getAsset(network: Network, assetId: string): Promise<CompressedAssetRecord | null>;
  /** A fresh proof; proofs go stale whenever the tree changes, so never cache one across writes. */
  getAssetProof(network: Network, assetId: string): Promise<CompressedAssetProof>;
}

export type ScreeningOutcome = "clear" | "review" | "blocked";

/** KYC and sanctions screening by a real provider; every intent passes it before anything is prepared. */
export interface CompliancePort {
  screen(subject: { kind: "person" | "organisation" | "wallet"; reference: string; network?: Network }): Promise<{
    outcome: ScreeningOutcome;
    provider: string;
    reference: string;
    checkedAt: Date;
    reasons: string[];
  }>;
}
