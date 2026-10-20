/**
 * Ownership of compressed NFTs read through DAS, reusing the existing `CompressedAssetPort`
 * (DasCompressedAssetAdapter). Read-only. When DAS also returns a proof that hashes to a root the
 * on-chain tree still accepts, the reading is `inclusion_verified`; the adapter does not recompute
 * the leaf from the reported owner, so that binding stays the indexer's word.
 */
import type { ChainAssetRef, CompressedAssetPort, Network, OwnershipReader, OwnershipReading } from "@metafarm/domain";

export class DasOwnershipReader implements OwnershipReader {
  readonly source = "das" as const;

  constructor(
    private readonly das: CompressedAssetPort,
    private readonly network: Network,
  ) {}

  async holdersOf(asset: ChainAssetRef): Promise<OwnershipReading | null> {
    if (asset.rail !== "SOLANA_BUBBLEGUM_CNFT" || asset.network !== this.network) return null;
    const a = await this.das.getAsset(this.network, asset.id);
    if (!a) return null;
    if (!a.compressed) return null;
    if (a.burnt) return { holders: [], asOfSlot: null, assurance: "indexer_reported" };
    let assurance: OwnershipReading["assurance"] = "indexer_reported";
    try {
      await this.das.getAssetProof(this.network, asset.id);
      assurance = "inclusion_verified";
    } catch {
      // A stale or unavailable proof leaves the reading as the indexer reported it.
    }
    return { holders: [{ owner: a.owner, amount: 1n }], asOfSlot: null, assurance };
  }
}
