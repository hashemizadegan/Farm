/**
 * Bubblegum compressed NFTs: the Merkle trees the platform mints into, the leaf each one-of-a-kind
 * asset becomes, and registration orders. The database enforces the rules (migration 0016): one
 * current tree per workspace and network, a tree's shape fixed once it has an address, the count
 * of minted leaves never decreasing or exceeding capacity, one mint in flight per tree.
 */
import type { Network, OrderStatus, TreeStatus } from "@metafarm/domain";
import type { SystemTx, TenantTx } from "../tenant";

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

/**
 * Leaf metadata as stored: what the leaf hashes (name, symbol, uri) and the public commitment, plus
 * the commitment's salt, which never leaves the database.
 */
export interface StoredCnftMetadata {
  name: string;
  symbol: string;
  uri: string;
  commitment: { algorithm: "sha256"; scheme: string; hash: string };
  commitmentSalt: string;
}

/**
 * Plans a compressed NFT for a verified one-of-a-kind asset with the metadata its leaf will carry.
 * The tree is assigned when the mint starts (`assignTree`), unless given here. Pass `id` when the
 * metadata URI already names the representation.
 */
export async function createCompressedRepresentation(
  tx: TenantTx,
  r: { id?: string; assetId: string; network: Network; metadata: StoredCnftMetadata; treeId?: string },
): Promise<string> {
  return (
    await tx.query<{ id: string }>(
      `INSERT INTO asset_representations (id, tenant_id, asset_id, rail, network, cnft_metadata, tree_id)
       VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, 'SOLANA_BUBBLEGUM_CNFT', $4, $5::jsonb, $6) RETURNING id`,
      [r.id ?? null, tx.tenantId, r.assetId, r.network, JSON.stringify(r.metadata), r.treeId ?? null],
    )
  ).rows[0]!.id;
}

/**
 * Puts a planned leaf in a tree. Never moves it once set: mint intents reference the pair. Returns
 * whether the representation is (now) in that tree.
 */
export async function assignTree(tx: TenantTx, representationId: string, treeId: string): Promise<boolean> {
  const r = await tx.query<{ tree_id: string | null }>(
    `UPDATE asset_representations SET tree_id = coalesce(tree_id, $3), updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND rail = 'SOLANA_BUBBLEGUM_CNFT' RETURNING tree_id`,
    [tx.tenantId, representationId, treeId],
  );
  return r.rows[0]?.tree_id === treeId;
}

/**
 * The leaf a prepared mint will create: the tree address, its index (the tree's count when the
 * mint was prepared), the asset id derived from them and the leaf hash. Replaced if that attempt
 * expires and a new one is prepared; fixed once the leaf is active.
 */
export async function recordPlannedLeaf(
  tx: TenantTx,
  representationId: string,
  leaf: { merkleTree: string; leafIndex: bigint; assetId: string; leafHash?: string },
): Promise<boolean> {
  const r = await tx.query(
    `UPDATE asset_representations SET merkle_tree = $3, leaf_index = $4::bigint, das_asset_id = $5, leaf_hash = $6, status = 'issuing', updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND rail = 'SOLANA_BUBBLEGUM_CNFT' AND status IN ('planned', 'issuing')`,
    [tx.tenantId, representationId, leaf.merkleTree, leaf.leafIndex.toString(), leaf.assetId, leaf.leafHash ?? null],
  );
  return (r.rowCount ?? 0) === 1;
}

/**
 * Gives back the tree position a mint that will never land had claimed (it failed or was refused),
 * so the next mint into the tree can use that index. The tree and the metadata stay.
 */
export async function releasePlannedLeaf(tx: TenantTx, representationId: string): Promise<boolean> {
  const r = await tx.query(
    `UPDATE asset_representations SET merkle_tree = NULL, leaf_index = NULL, das_asset_id = NULL, leaf_hash = NULL, status = 'planned', updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND rail = 'SOLANA_BUBBLEGUM_CNFT' AND status = 'issuing'`,
    [tx.tenantId, representationId],
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

// ── Registrations, trees and leaves for the engine and the API ───────────

/** Approved registrations whose leaf the engine may start, across workspaces. */
export async function registrationsToAdvance(tx: SystemTx, limit = 500): Promise<{ tenant_id: string; id: string }[]> {
  return (
    await tx.query<{ tenant_id: string; id: string }>(
      `SELECT tenant_id, id FROM rwa_orders WHERE kind = 'registration' AND status = 'issuing' ORDER BY updated_at LIMIT $1`,
      [limit],
    )
  ).rows;
}

/** Trees still being created, across workspaces. */
export async function treesToDrive(tx: SystemTx, limit = 100): Promise<{ tenant_id: string; id: string }[]> {
  return (
    await tx.query<{ tenant_id: string; id: string }>(
      `SELECT tenant_id, id FROM merkle_trees WHERE status IN ('planned', 'creating') ORDER BY created_at LIMIT $1`,
      [limit],
    )
  ).rows;
}

export interface RegistrationRow {
  id: string;
  reconciliation_id: string;
  status: OrderStatus;
  party_id: string;
  party_name: string;
  custodian_address: string;
  created_by: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
  representation_id: string;
  asset_id: string;
  asset_name: string;
  asset_kind: string;
  network: Network;
  representation_status: string;
  tree_id: string | null;
  tree_address: string | null;
  leaf_index: string | null;
  das_asset_id: string | null;
  leaf_hash: string | null;
  metadata_uri: string;
}

const REGISTRATION_SELECT = `
  SELECT o.id, o.reconciliation_id, o.status, o.party_id, p.display_name AS party_name, o.investor_solana_address AS custodian_address,
         o.created_by, o.approved_by, o.approved_at, o.created_at, o.updated_at,
         r.id AS representation_id, r.asset_id, a.name AS asset_name, a.kind AS asset_kind, r.network, r.status AS representation_status,
         r.tree_id, t.address AS tree_address, r.leaf_index::text, r.das_asset_id, r.leaf_hash, r.cnft_metadata->>'uri' AS metadata_uri
    FROM rwa_orders o
    JOIN parties p ON p.tenant_id = o.tenant_id AND p.id = o.party_id
    JOIN asset_representations r ON r.tenant_id = o.tenant_id AND r.id = o.representation_id
    JOIN business_assets a ON a.tenant_id = r.tenant_id AND a.id = r.asset_id
    LEFT JOIN merkle_trees t ON t.tenant_id = r.tenant_id AND t.id = r.tree_id
   WHERE o.kind = 'registration'`;

export async function listRegistrations(tx: TenantTx, limit = 200): Promise<RegistrationRow[]> {
  return (await tx.query<RegistrationRow>(`${REGISTRATION_SELECT} AND o.tenant_id = $1 ORDER BY o.created_at DESC LIMIT $2`, [tx.tenantId, limit])).rows;
}

export async function getRegistration(tx: TenantTx, orderId: string, forUpdate = false): Promise<RegistrationRow | undefined> {
  if (forUpdate) await tx.query(`SELECT 1 FROM rwa_orders WHERE tenant_id = $1 AND id = $2 AND kind = 'registration' FOR UPDATE`, [tx.tenantId, orderId]);
  return (await tx.query<RegistrationRow>(`${REGISTRATION_SELECT} AND o.tenant_id = $1 AND o.id = $2`, [tx.tenantId, orderId])).rows[0];
}

/** Leaves whose mint is final but which DAS has not yet been seen to index, across workspaces. */
export async function leavesToConfirm(tx: SystemTx, limit = 200): Promise<{ tenant_id: string; id: string }[]> {
  return (
    await tx.query<{ tenant_id: string; id: string }>(
      `SELECT r.tenant_id, r.id FROM asset_representations r
        WHERE r.rail = 'SOLANA_BUBBLEGUM_CNFT' AND r.status = 'issuing' AND r.das_asset_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM issuance_intents i WHERE i.tenant_id = r.tenant_id AND i.representation_id = r.id AND i.action = 'mint' AND i.status = 'completed')
        ORDER BY r.updated_at LIMIT $1`,
      [limit],
    )
  ).rows;
}

/** What DAS must report for a minted leaf: its asset id, tree, index and owner (the mint's holder). */
export async function leafForConfirmation(tx: TenantTx, representationId: string) {
  return (
    await tx.query<{ network: Network; das_asset_id: string; merkle_tree: string; leaf_index: string; owner: string; reconciliation_id: string }>(
      `SELECT r.network, r.das_asset_id, r.merkle_tree, r.leaf_index::text, i.holder_address AS owner, i.reconciliation_id
         FROM asset_representations r
         JOIN issuance_intents i ON i.tenant_id = r.tenant_id AND i.representation_id = r.id AND i.action = 'mint' AND i.status = 'completed'
        WHERE r.tenant_id = $1 AND r.id = $2 AND r.status = 'issuing' AND r.das_asset_id IS NOT NULL
        ORDER BY i.updated_at DESC LIMIT 1`,
      [tx.tenantId, representationId],
    )
  ).rows[0];
}

/** The public metadata document of a compressed NFT (never the commitment's salt). */
export async function publicCnftMetadata(tx: SystemTx, representationId: string) {
  return (
    await tx.query<{
      name: string;
      symbol: string;
      uri: string;
      commitment: StoredCnftMetadata["commitment"];
      kind: string;
      network: Network;
      status: string;
      das_asset_id: string | null;
    }>(
      `SELECT r.cnft_metadata->>'name' AS name, r.cnft_metadata->>'symbol' AS symbol, r.cnft_metadata->>'uri' AS uri,
              r.cnft_metadata->'commitment' AS commitment, a.kind, r.network, r.status, r.das_asset_id
         FROM asset_representations r JOIN business_assets a ON a.tenant_id = r.tenant_id AND a.id = r.asset_id
        WHERE r.id = $1 AND r.rail = 'SOLANA_BUBBLEGUM_CNFT' AND r.cnft_metadata IS NOT NULL`,
      [representationId],
    )
  ).rows[0];
}
