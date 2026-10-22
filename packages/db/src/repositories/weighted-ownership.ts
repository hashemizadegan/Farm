/**
 * Y5: the real ownership-source adapter boundary. Reads an asset's verified history (provenance rules in
 * readVerifiedOwnershipHistory), the tenant's wallet-to-party map, and builds the slot-weighted ownership input
 * (packages/domain twin/holding-weights). Read-only; nothing here contacts a chain or an RPC endpoint.
 *
 * Fails closed with stable codes:
 * - HoldingWeightError: `not_indexed`, `incomplete_history`, `unverified_source`, `fixture_in_real_cycle`,
 *   `ownership_conflict`, `no_holdings`, `invalid_window`, …
 * - OwnershipProvenanceError: `ambiguous_provenance` (a fixture cursor beside verified RPC events).
 */
import { type ChainAssetRef, type HoldingWindow, HoldingWeightError, type Network, type WeightedOwnershipInput, buildWeightedOwnershipInput } from "@metafarm/domain";
import type { Pool } from "../pool";
import { type TenantTx, withTenant } from "../tenant";
import { readVerifiedOwnershipHistory } from "./ownership-index";

/**
 * The tenant's registered wallets on a network, address → party id (party_wallets, migration 0012). An address
 * belongs to at most one party (unique per tenant, network and address). Player wallets (0022) are a separate
 * table and never appear here: a player-only address stays unattributed (plan §4.3).
 */
export async function partyWalletMap(tx: TenantTx, network: Network): Promise<Map<string, string>> {
  const r = await tx.query<{ address: string; party_id: string }>(`SELECT address, party_id::text AS party_id FROM party_wallets WHERE network = $1 ORDER BY address`, [network]);
  const m = new Map<string, string>();
  for (const x of r.rows) {
    if (m.has(x.address) && m.get(x.address) !== x.party_id) throw new HoldingWeightError("duplicate_wallet", `address ${x.address} is registered to two parties`);
    m.set(x.address, x.party_id);
  }
  return m;
}

/** Builds a tenant's weighted ownership input for one asset and window from the verified index. */
export async function loadWeightedOwnershipInput(pool: Pool, tenantId: string, params: { asset: ChainAssetRef; window: HoldingWindow; simulation: boolean }): Promise<WeightedOwnershipInput> {
  const history = await readVerifiedOwnershipHistory(pool, params.asset);
  if (!history) throw new HoldingWeightError("not_indexed", `${params.asset.id} is not indexed from a verified source`);
  const partyOfWallet = await withTenant(pool, tenantId, (tx) => partyWalletMap(tx, params.asset.network));
  return buildWeightedOwnershipInput({
    history: {
      asset: params.asset,
      events: history.events,
      provenance: { sourceKind: history.sourceKind, sourceIdentity: history.sourceIdentity, cursorSlot: history.indexedThroughSlot },
    },
    window: params.window,
    partyOfWallet,
    simulation: params.simulation,
  });
}
