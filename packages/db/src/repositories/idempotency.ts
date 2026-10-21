/**
 * Idempotency records (migration 0021) for tenant-scoped writes. Runs in the request's tenant
 * transaction as the application role; rows are scoped to (tenant, user, key).
 */
import type { TenantTx } from "../tenant";

export interface IdempotencyRequest {
  tenantId: string;
  userId: string;
  key: string;
  method: string;
  route: string;
  requestHash: string;
}

export interface StoredIdempotency {
  method: string;
  route: string;
  requestHash: string;
  state: "pending" | "completed";
  statusCode: number | null;
  contentType: string | null;
  body: string | null;
  createdAt: Date;
}

/** How long a key is remembered. A resend after this records again. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;

/**
 * Reserves the key for this request, or returns what is already stored under it. Also forgets this
 * user's records older than the retention period, so the table stays bounded without a scheduled job.
 */
export async function reserveIdempotency(tx: TenantTx, r: IdempotencyRequest): Promise<{ reserved: true } | { reserved: false; existing: StoredIdempotency }> {
  await tx.query(
    `DELETE FROM idempotency_records
      WHERE tenant_id = $1 AND user_id = $2 AND created_at < now() - make_interval(hours => $3)`,
    [r.tenantId, r.userId, IDEMPOTENCY_RETENTION_HOURS],
  );
  const ins = await tx.query(
    `INSERT INTO idempotency_records (tenant_id, user_id, key, method, route, request_hash, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     ON CONFLICT (tenant_id, user_id, key) DO NOTHING`,
    [r.tenantId, r.userId, r.key, r.method, r.route, r.requestHash],
  );
  if (ins.rowCount === 1) return { reserved: true };
  const { rows } = await tx.query<{
    method: string;
    route: string;
    request_hash: string;
    state: "pending" | "completed";
    status_code: number | null;
    content_type: string | null;
    response_body: string | null;
    created_at: Date;
  }>(
    `SELECT method, route, request_hash, state, status_code, content_type, response_body, created_at
       FROM idempotency_records WHERE tenant_id = $1 AND user_id = $2 AND key = $3`,
    [r.tenantId, r.userId, r.key],
  );
  const row = rows[0];
  // Deleted between the insert and the select (expired): treat as a conflict the client can retry.
  if (!row) throw new Error("idempotency record vanished; retry");
  return {
    reserved: false,
    existing: {
      method: row.method,
      route: row.route,
      requestHash: row.request_hash,
      state: row.state,
      statusCode: row.status_code,
      contentType: row.content_type,
      body: row.response_body,
      createdAt: row.created_at,
    },
  };
}

/** Stores the successful response of the request that holds the reservation. */
export async function completeIdempotency(
  tx: TenantTx,
  r: Pick<IdempotencyRequest, "tenantId" | "userId" | "key">,
  res: { statusCode: number; contentType: string | null; body: string },
): Promise<void> {
  await tx.query(
    `UPDATE idempotency_records
        SET state = 'completed', status_code = $4, content_type = $5, response_body = $6, completed_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND key = $3 AND state = 'pending'`,
    [r.tenantId, r.userId, r.key, res.statusCode, res.contentType, res.body],
  );
}

/** Releases a reservation whose request failed, so the client may retry with the same key. */
export async function releaseIdempotency(tx: TenantTx, r: Pick<IdempotencyRequest, "tenantId" | "userId" | "key">): Promise<void> {
  await tx.query(`DELETE FROM idempotency_records WHERE tenant_id = $1 AND user_id = $2 AND key = $3 AND state = 'pending'`, [r.tenantId, r.userId, r.key]);
}
