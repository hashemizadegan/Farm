/**
 * Transfer preparation without submission. A preview states exactly what a transfer would do, is
 * fingerprinted (SHA-256 of its canonical JSON) so a later signature request can be matched to it,
 * and expires. It is refused unless the chain's current holders are known and include the sender:
 * the platform never prepares a transfer on the strength of its own records alone.
 *
 * Nothing here builds, signs or sends a transaction; `submission.available` is false in this release.
 */
import { canonicalJson } from "../harvest";
import { networkAllowed } from "../rwa/model";
import { contentHash } from "./commitments";
import type { ChainAssetRef } from "./ownership";
import type { OwnershipReading, SubmissionUnavailableReason } from "./ports";

export const TRANSFER_PREVIEW_SCHEME = "metafarm-transfer-preview/1";
/** How long a preview stays valid. */
export const TRANSFER_PREVIEW_TTL_SECONDS = 120;

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const TRANSFER_REFUSALS = [
  "network_not_allowed",
  "rail_not_transferable",
  "invalid_address",
  "same_address",
  "invalid_amount",
  "ownership_not_indexed",
  "sender_not_holder",
] as const;
export type TransferRefusal = (typeof TRANSFER_REFUSALS)[number];

export class TransferRefused extends Error {
  constructor(
    readonly code: TransferRefusal,
    message: string,
  ) {
    super(message);
    this.name = "TransferRefused";
  }
}

export interface TransferPreviewRequest {
  asset: ChainAssetRef;
  from: string;
  to: string;
  /** Base units; 1 for a compressed NFT. */
  amount: bigint;
}

export interface TransferPreview {
  scheme: typeof TRANSFER_PREVIEW_SCHEME;
  asset: ChainAssetRef;
  from: string;
  to: string;
  amount: bigint;
  createdAt: Date;
  expiresAt: Date;
  /** SHA-256 (hex) of the canonical preview; a signature request must carry the same digest. */
  digest: string;
  /** What the chain said when the preview was made. */
  ownershipAsOfSlot: bigint | null;
  submission: { available: false; reason: SubmissionUnavailableReason };
}

export async function previewTransfer(
  req: TransferPreviewRequest,
  o: {
    now: Date;
    mainnetEnabled: boolean;
    /** Current holders from an ownership reader; null when nothing covers the asset. */
    holders: OwnershipReading | null;
    submissionUnavailable: SubmissionUnavailableReason;
    ttlSeconds?: number;
  },
): Promise<TransferPreview> {
  const { asset, from, to, amount } = req;
  if (!networkAllowed(asset.network, { mainnetEnabled: o.mainnetEnabled })) throw new TransferRefused("network_not_allowed", `${asset.network} is not enabled`);
  if (asset.rail !== "SOLANA_TOKEN_2022" && asset.rail !== "SOLANA_BUBBLEGUM_CNFT")
    throw new TransferRefused("rail_not_transferable", "only Solana share tokens and compressed NFTs can be transferred here");
  if (!BASE58_ADDRESS.test(asset.id) || !BASE58_ADDRESS.test(from) || !BASE58_ADDRESS.test(to)) throw new TransferRefused("invalid_address", "addresses must be base58 Solana addresses");
  if (from === to) throw new TransferRefused("same_address", "sender and recipient are the same");
  if (amount <= 0n || amount > 0xffff_ffff_ffff_ffffn) throw new TransferRefused("invalid_amount", "amount must be a positive u64");
  if (asset.rail === "SOLANA_BUBBLEGUM_CNFT" && amount !== 1n) throw new TransferRefused("invalid_amount", "a compressed NFT moves whole (amount 1)");
  if (!o.holders) throw new TransferRefused("ownership_not_indexed", "the asset's current holders on chain are not known");
  const held = o.holders.holders.find((h) => h.owner === from)?.amount ?? 0n;
  if (held < amount) throw new TransferRefused("sender_not_holder", "the sender does not hold enough of this asset on chain");

  const createdAt = o.now;
  const expiresAt = new Date(createdAt.getTime() + (o.ttlSeconds ?? TRANSFER_PREVIEW_TTL_SECONDS) * 1000);
  const digest = await contentHash(
    canonicalJson({
      scheme: TRANSFER_PREVIEW_SCHEME,
      asset,
      from,
      to,
      amount: amount.toString(),
      expiresAt: expiresAt.toISOString(),
    }),
  );
  return {
    scheme: TRANSFER_PREVIEW_SCHEME,
    asset,
    from,
    to,
    amount,
    createdAt,
    expiresAt,
    digest,
    ownershipAsOfSlot: o.holders.asOfSlot,
    submission: { available: false, reason: o.submissionUnavailable },
  };
}
