/**
 * Bubblegum compressed NFTs: the Merkle trees the platform mints into, the leaf each one-of-a-kind
 * asset becomes, and registration orders. The database enforces the rules (migration 0016): one
 * current tree per workspace and network, a tree's shape fixed once it has an address, the count
 * of minted leaves never decreasing or exceeding capacity, one mint in flight per tree.
 */
import type { Network, TreeStatus } from "@metafarm/domain";
import type { TenantTx } from "../tenant";

export interface TreeRow {
  id: string;
  network: Network;
  status: TreeStatus;
  address: string | null;
  max_depth: number;
  max_buffer_size: number;
  canopy_depth: number;
  capacity: string;
  creator_address: string;
  minted_count: string;
  created_at: Date;
  updated_at: Date;
}

const TREE_SELECT = `SELECT id, network, status, address, max_depth, max_buffer_size, canopy_depth, capacity::text, creator_address, minted_count::text, created_at, updated_at FROM merkle_trees`;

/** Records the tree to create (shape from `planTree` in @metafarm/chain). Fails if the workspace already has a current tree on that network. */
export async function planMerkleTree(
  tx: TenantTx,
  t: {
    network: Network;
    maxDepth: number;
    maxBufferSize: number;
    canopyDepth: number;
    capacity: bigint;
    creatorAddress: string;
    createdBy: string | null;
  },
): Promise<string> {
  return (
    await tx.query<{ id: string }>(
      `INSERT INTO merkle_trees (tenant_id, network, max_depth, max_buffer_size, canopy_depth, capacity, creator_address, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8) RETURNING id`,
      [
        tx.tenantId,
        t.network,
        t.maxDepth,
        t.maxBufferSize,
        t.canopyDepth,
        t.capacity.toString(),
        t.creatorAddress,
        t.createdBy,
      ],
    )
  ).rows[0]!.id;
}

/** The workspace's tree in use on a network (planned, being created or active), if any. */
export async function currentMerkleTree(
  tx: TenantTx,
  network: Network,
  forUpdate = false,
): Promise<TreeRow | undefined> {
  return (
    await tx.query<TreeRow>(
      `${TREE_SELECT} WHERE tenant_id = $1 AND network = $2 AND status IN ('planned', 'creating', 'active')${forUpdate ? " FOR UPDATE" : ""}`,
      [tx.tenantId, network],
    )
  ).rows[0];
}

export async function getMerkleTree(
  tx: TenantTx,
  id: string,
  forUpdate = false,
): Promise<TreeRow | undefined> {
  return (
    await tx.query<TreeRow>(
      `${TREE_SELECT} WHERE tenant_id = $1 AND id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [tx.tenantId, id],
    )
  ).rows[0];
}

/** planned → creating, with the account address generated for the creation transaction. False if the tree had moved on. */
export async function markMerkleTreeCreating(tx: TenantTx, id: string, address: string): Promise<boolean> {
  const r = await tx.query(
    `UPDATE merkle_trees SET status = 'creating', address = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'planned'`,
    [tx.tenantId, id, address],
  );
  return (r.rowCount ?? 0) === 1;
}

/** creating → active, once the creation transaction is final. */
export async function activateMerkleTree(tx: TenantTx, id: string): Promise<boolean> {
  const r = await tx.query(
    `UPDATE merkle_trees SET status = 'active' WHERE tenant_id = $1 AND id = $2 AND status = 'creating'`,
    [tx.tenantId, id],
  );
  return (r.rowCount ?? 0) === 1;
}

/** planned/creating → failed, once creation definitively failed or provably expired; a new tree may then be planned. */
export async function failMerkleTree(tx: TenantTx, id: string): Promise<boolean> {
  const r = await tx.query(
    `UPDATE merkle_trees SET status = 'failed' WHERE tenant_id = $1 AND id = $2 AND status IN ('planned', 'creating')`,
    [tx.tenantId, id],
  );
  return (r.rowCount ?? 0) === 1;
}

/**
 * Counts one more final leaf; the tree becomes `full` with its last leaf. Returns the new count and
 * status, or undefined if the tree is not active (nothing is changed then).
 */
export async function recordLeafMinted(
  tx: TenantTx,
  treeId: string,
): Promise<{ mintedCount: bigint; status: TreeStatus } | undefined> {
  const r = await tx.query<{ minted_count: string; status: TreeStatus }>(
    `UPDATE merkle_trees
        SET minted_count = minted_count + 1,
            status = CASE WHEN minted_count + 1 = capacity THEN 'full' ELSE status END
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'
      RETURNING minted_count::text, status`,
    [tx.tenantId, treeId],
  );
  const row = r.rows[0];
  return row ? { mintedCount: BigInt(row.minted_count), status: row.status } : undefined;
}

// ── Leaves ─────────────────────────────────────────────────────────────

/** Plans a compressed NFT for a verified one-of-a-kind asset, in the given tree. */
export async function createCompressedRepresentation(
  tx: TenantTx,
  assetId: string,
  network: Network,
  treeId: string,
): Promise<string> {
  return (
    await tx.query<{ id: string }>(
      `INSERT INTO asset_representations (tenant_id, asset_id, rail, network, tree_id) VALUES ($1, $2, 'SOLANA_BUBBLEGUM_CNFT', $3, $4) RETURNING id`,
      [tx.tenantId, assetId, network, treeId],
    )
  ).rows[0]!.id;
}

/**
 * The leaf a prepared mint will create: the tree address, its index (the tree's count when the
 * mint was prepared) and the asset id derived from them. Replaced if that attempt expires and a
 * new one is prepared; fixed once the leaf is active.
 */
export async function recordPlannedLeaf(
  tx: TenantTx,
  representationId: string,
  leaf: { merkleTree: string; leafIndex: bigint; assetId: string },
): Promise<boolean> {
  const r = await tx.query(
    `UPDATE asset_representations SET merkle_tree = $3, leaf_index = $4::bigint, das_asset_id = $5, status = 'issuing', updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND rail = 'SOLANA_BUBBLEGUM_CNFT' AND status IN ('planned', 'issuing')`,
    [tx.tenantId, representationId, leaf.merkleTree, leaf.leafIndex.toString(), leaf.assetId],
  );
  return (r.rowCount ?? 0) === 1;
}

/** issuing → active, once DAS reports the asset at the expected tree and leaf. */
export async function activateLeaf(tx: TenantTx, representationId: string): Promise<boolean> {
  const r = await tx.query(
    `UPDATE asset_representations SET status = 'active', updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND rail = 'SOLANA_BUBBLEGUM_CNFT' AND status = 'issuing' AND das_asset_id IS NOT NULL`,
    [tx.tenantId, representationId],
  );
  return (r.rowCount ?? 0) === 1;
}

// ── Registration orders ─────────────────────────────────────────────────

/**
 * Records that a verified asset is to be minted as one leaf to its custodian party's screened Solana
 * wallet. No money moves; the custodian passes the same compliance gate as any investor.
 */
export async function createRegistrationOrder(
  tx: TenantTx,
  o: { partyId: string; representationId: string; custodianSolanaAddress: string; createdBy: string | null },
): Promise<{ id: string; reconciliationId: string }> {
  const r = await tx.query<{ id: string; reconciliation_id: string }>(
    `INSERT INTO rwa_orders (tenant_id, kind, party_id, representation_id, share_amount, investor_solana_address, created_by)
     VALUES ($1, 'registration', $2, $3, 1, $4, $5) RETURNING id, reconciliation_id`,
    [tx.tenantId, o.partyId, o.representationId, o.custodianSolanaAddress, o.createdBy],
  );
  return { id: r.rows[0]!.id, reconciliationId: r.rows[0]!.reconciliation_id };
}
