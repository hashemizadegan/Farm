/**
 * Digital twin reads and verifiable off-chain data (migration 0019). The twin reads the existing
 * asset registry; it has no asset table of its own. Commitments and batches are append-only: the
 * application role may insert and select, never update or delete.
 */
import type { DataSubjectType } from "@metafarm/domain";
import type { TenantTx } from "../tenant";
import type { BusinessAssetRow } from "./rwa-execution";

export interface TwinChainRow {
  id: string;
  asset_id: string;
  rail: string;
  network: string;
  status: string;
  /** Mint (Token-2022), DAS asset id (Bubblegum) or contract (TRC-20). */
  chain_id: string | null;
}

const ASSET_COLUMNS = `
  a.id, a.farm_id, f.name AS farm_name, a.kind, a.name, a.external_ref, a.parcel_label,
  CASE WHEN a.geom IS NULL THEN NULL ELSE ST_AsGeoJSON(a.geom, 7)::json END AS geometry, a.geom_provenance,
  a.status, a.verified_at, a.created_by, a.created_at`;

/** Assets of one farm, oldest first, at most `limit` after the cursor (an asset id). */
export async function twinAssetsOfFarm(tx: TenantTx, farmId: string, limit: number, afterId?: string): Promise<BusinessAssetRow[]> {
  return (
    await tx.query<BusinessAssetRow>(
      `SELECT ${ASSET_COLUMNS}
         FROM business_assets a JOIN farms f ON f.tenant_id = a.tenant_id AND f.id = a.farm_id
        WHERE a.tenant_id = $1 AND a.farm_id = $2 AND a.status <> 'retired'
          AND ($3::uuid IS NULL OR (a.created_at, a.id) > (SELECT created_at, id FROM business_assets WHERE tenant_id = $1 AND id = $3))
        ORDER BY a.created_at, a.id
        LIMIT $4`,
      [tx.tenantId, farmId, afterId ?? null, limit],
    )
  ).rows;
}

export async function twinChainIdentities(tx: TenantTx, assetIds: string[]): Promise<TwinChainRow[]> {
  if (assetIds.length === 0) return [];
  return (
    await tx.query<TwinChainRow>(
      `SELECT id, asset_id, rail, network, status, COALESCE(mint_address, das_asset_id, contract_address) AS chain_id
         FROM asset_representations
        WHERE tenant_id = $1 AND asset_id = ANY($2::uuid[])
        ORDER BY created_at, id`,
      [tx.tenantId, assetIds],
    )
  ).rows;
}

export async function twinChainIdentity(tx: TenantTx, representationId: string): Promise<TwinChainRow | undefined> {
  return (
    await tx.query<TwinChainRow>(
      `SELECT id, asset_id, rail, network, status, COALESCE(mint_address, das_asset_id, contract_address) AS chain_id
         FROM asset_representations WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, representationId],
    )
  ).rows[0];
}

/** Counts for the sync-status view. */
export async function twinChainCounts(tx: TenantTx): Promise<{ representations: number; with_chain_id: number; active: number }> {
  const r = await tx.query<{ representations: string; with_chain_id: string; active: string }>(
    `SELECT count(*) AS representations,
            count(*) FILTER (WHERE COALESCE(mint_address, das_asset_id, contract_address) IS NOT NULL) AS with_chain_id,
            count(*) FILTER (WHERE status = 'active') AS active
       FROM asset_representations WHERE tenant_id = $1`,
    [tx.tenantId],
  );
  const row = r.rows[0]!;
  return { representations: Number(row.representations), with_chain_id: Number(row.with_chain_id), active: Number(row.active) };
}

// ── Data commitments ───────────────────────────────────────────────────

export interface DataCommitmentRow {
  id: string;
  farm_id: string | null;
  subject_type: DataSubjectType;
  subject_id: string;
  data_schema: string;
  schema_version: number;
  content_sha256: string;
  byte_size: string | null;
  storage_ref: string | null;
  source_time: Date;
  attestation_ref: string | null;
  recorded_by: string | null;
  client_request_id: string | null;
  created_at: Date;
  batch_id: string | null;
  leaf_index: number | null;
}

const COMMITMENT_SELECT = `
  SELECT c.id, c.farm_id, c.subject_type, c.subject_id, c.data_schema, c.schema_version, c.content_sha256,
         c.byte_size::text, c.storage_ref, c.source_time, c.attestation_ref, c.recorded_by, c.client_request_id,
         c.created_at, l.batch_id, l.leaf_index
    FROM data_commitments c
    LEFT JOIN commitment_batch_leaves l ON l.tenant_id = c.tenant_id AND l.commitment_id = c.id`;

export interface NewDataCommitment {
  farmId: string | null;
  subjectType: DataSubjectType;
  subjectId: string;
  schema: string;
  schemaVersion: number;
  contentSha256: string;
  byteSize: number | null;
  storageRef: string | null;
  sourceTime: Date;
  attestationRef: string | null;
  recordedBy: string;
  clientRequestId: string | null;
}

/**
 * Records a commitment. The same subject, schema, version and hash is one fact: recording it again
 * returns the existing row (`created: false`) instead of a duplicate.
 */
export async function insertDataCommitment(tx: TenantTx, c: NewDataCommitment): Promise<{ row: DataCommitmentRow; created: boolean }> {
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO data_commitments (tenant_id, farm_id, subject_type, subject_id, data_schema, schema_version, content_sha256,
                                   byte_size, storage_ref, source_time, attestation_ref, recorded_by, client_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (tenant_id, subject_type, subject_id, data_schema, schema_version, content_sha256) DO NOTHING
     RETURNING id`,
    [tx.tenantId, c.farmId, c.subjectType, c.subjectId, c.schema, c.schemaVersion, c.contentSha256, c.byteSize, c.storageRef, c.sourceTime, c.attestationRef, c.recordedBy, c.clientRequestId],
  );
  if (ins.rows[0]) return { row: (await getDataCommitment(tx, ins.rows[0].id))!, created: true };
  const existing = await tx.query<DataCommitmentRow>(
    `${COMMITMENT_SELECT} WHERE c.tenant_id = $1 AND c.subject_type = $2 AND c.subject_id = $3 AND c.data_schema = $4 AND c.schema_version = $5 AND c.content_sha256 = $6`,
    [tx.tenantId, c.subjectType, c.subjectId, c.schema, c.schemaVersion, c.contentSha256],
  );
  return { row: existing.rows[0]!, created: false };
}

export async function getDataCommitment(tx: TenantTx, id: string): Promise<DataCommitmentRow | undefined> {
  return (await tx.query<DataCommitmentRow>(`${COMMITMENT_SELECT} WHERE c.tenant_id = $1 AND c.id = $2`, [tx.tenantId, id])).rows[0];
}

export async function findDataCommitmentByRequest(tx: TenantTx, requestId: string): Promise<DataCommitmentRow | undefined> {
  return (await tx.query<DataCommitmentRow>(`${COMMITMENT_SELECT} WHERE c.tenant_id = $1 AND c.client_request_id = $2`, [tx.tenantId, requestId])).rows[0];
}

/** Commitments, newest first; `before` is the id of the last row of the previous page. */
export async function listDataCommitments(
  tx: TenantTx,
  q: { subjectType?: DataSubjectType; subjectId?: string; limit: number; before?: string },
): Promise<DataCommitmentRow[]> {
  return (
    await tx.query<DataCommitmentRow>(
      `${COMMITMENT_SELECT}
        WHERE c.tenant_id = $1
          AND ($2::text IS NULL OR c.subject_type = $2)
          AND ($3::text IS NULL OR c.subject_id = $3)
          AND ($4::uuid IS NULL OR (c.created_at, c.id) < (SELECT created_at, id FROM data_commitments WHERE tenant_id = $1 AND id = $4))
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $5`,
      [tx.tenantId, q.subjectType ?? null, q.subjectId ?? null, q.before ?? null, q.limit],
    )
  ).rows;
}

/** The given commitments, locked against joining two batches at once, in the order asked. */
export async function lockCommitmentsForBatch(tx: TenantTx, ids: string[]): Promise<DataCommitmentRow[]> {
  await tx.query(`SELECT 1 FROM data_commitments WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [tx.tenantId, ids]);
  const rows = (await tx.query<DataCommitmentRow>(`${COMMITMENT_SELECT} WHERE c.tenant_id = $1 AND c.id = ANY($2::uuid[])`, [tx.tenantId, ids])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

// ── Merkle batches ─────────────────────────────────────────────────────

export interface CommitmentBatchRow {
  id: string;
  dataset: string;
  scheme: string;
  merkle_root: string;
  leaf_count: number;
  created_by: string | null;
  client_request_id: string | null;
  created_at: Date;
}

const BATCH_SELECT = `SELECT id, dataset, scheme, merkle_root, leaf_count, created_by, client_request_id, created_at FROM commitment_batches`;

export async function insertCommitmentBatch(
  tx: TenantTx,
  b: { dataset: string; scheme: string; merkleRoot: string; leaves: { commitmentId: string; leafHash: string }[]; createdBy: string; clientRequestId: string | null },
): Promise<CommitmentBatchRow> {
  const id = (
    await tx.query<{ id: string }>(
      `INSERT INTO commitment_batches (tenant_id, dataset, scheme, merkle_root, leaf_count, created_by, client_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [tx.tenantId, b.dataset, b.scheme, b.merkleRoot, b.leaves.length, b.createdBy, b.clientRequestId],
    )
  ).rows[0]!.id;
  await tx.query(
    `INSERT INTO commitment_batch_leaves (tenant_id, batch_id, leaf_index, commitment_id, leaf_hash)
     SELECT $1, $2, x.i - 1, x.commitment_id, x.leaf_hash
       FROM unnest($3::uuid[], $4::text[]) WITH ORDINALITY AS x(commitment_id, leaf_hash, i)`,
    [tx.tenantId, id, b.leaves.map((l) => l.commitmentId), b.leaves.map((l) => l.leafHash)],
  );
  return (await getCommitmentBatch(tx, id))!;
}

export async function getCommitmentBatch(tx: TenantTx, id: string): Promise<CommitmentBatchRow | undefined> {
  return (await tx.query<CommitmentBatchRow>(`${BATCH_SELECT} WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id])).rows[0];
}

export async function findCommitmentBatchByRequest(tx: TenantTx, requestId: string): Promise<CommitmentBatchRow | undefined> {
  return (await tx.query<CommitmentBatchRow>(`${BATCH_SELECT} WHERE tenant_id = $1 AND client_request_id = $2`, [tx.tenantId, requestId])).rows[0];
}

/** A batch's leaves in order, with the commitment each one stands for. */
export async function commitmentBatchLeaves(tx: TenantTx, batchId: string): Promise<{ leaf_index: number; commitment_id: string; leaf_hash: string; content_sha256: string }[]> {
  return (
    await tx.query(
      `SELECT l.leaf_index, l.commitment_id, l.leaf_hash, c.content_sha256
         FROM commitment_batch_leaves l JOIN data_commitments c ON c.tenant_id = l.tenant_id AND c.id = l.commitment_id
        WHERE l.tenant_id = $1 AND l.batch_id = $2
        ORDER BY l.leaf_index`,
      [tx.tenantId, batchId],
    )
  ).rows;
}
