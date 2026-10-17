import type { CreateUploadInput } from "@metafarm/domain";
import type { TenantTx } from "../tenant";

export interface MediaRow {
  id: string;
  farm_id: string | null;
  storage_key: string;
  filename: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  purpose: CreateUploadInput["purpose"];
  status: "pending" | "uploaded" | "rejected" | "deleted";
  created_at: string;
}

export async function createPendingMedia(
  tx: TenantTx,
  input: CreateUploadInput & { storageKey: string; userId: string },
): Promise<MediaRow> {
  const r = await tx.query<MediaRow>(
    `INSERT INTO media_objects (tenant_id, farm_id, storage_key, filename, content_type, byte_size, sha256, purpose, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, farm_id, storage_key, filename, content_type, byte_size, sha256, purpose, status, created_at`,
    [
      tx.tenantId,
      input.farmId ?? null,
      input.storageKey,
      input.filename,
      input.contentType,
      input.byteSize,
      input.sha256,
      input.purpose,
      input.userId,
    ],
  );
  return r.rows[0]!;
}

export async function getMedia(tx: TenantTx, id: string): Promise<MediaRow | undefined> {
  const r = await tx.query<MediaRow>(
    `SELECT id, farm_id, storage_key, filename, content_type, byte_size, sha256, purpose, status, created_at
       FROM media_objects WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, id],
  );
  return r.rows[0];
}

export async function setMediaStatus(tx: TenantTx, id: string, status: MediaRow["status"]) {
  await tx.query(`UPDATE media_objects SET status = $3 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id, status]);
}

/** Uploaded (confirmed) files attached to a farm, newest first, optionally filtered by purpose. */
export async function listFarmMedia(tx: TenantTx, farmId: string, purpose?: string, limit = 100): Promise<(MediaRow & { uploaded_by_name: string | null })[]> {
  const r = await tx.query<MediaRow & { uploaded_by_name: string | null }>(
    `SELECT m.id, m.farm_id, m.storage_key, m.filename, m.content_type, m.byte_size, m.sha256, m.purpose, m.status, m.created_at,
            coalesce(u.display_name, u.email::text) AS uploaded_by_name
       FROM media_objects m LEFT JOIN users u ON u.id = m.uploaded_by
      WHERE m.tenant_id = $1 AND m.farm_id = $2 AND m.status = 'uploaded' AND ($3::text IS NULL OR m.purpose = $3)
      ORDER BY m.created_at DESC LIMIT $4`,
    [tx.tenantId, farmId, purpose ?? null, limit],
  );
  return r.rows;
}
