import type { Pool } from "../pool";
import type { SystemTx, TenantTx } from "../tenant";

// ── Audit ─────────────────────────────────────────────────────────────────

export interface AuditInput {
  actorUserId?: string | null;
  actorType: "user" | "system" | "webhook" | "job" | "device";
  action: string;
  targetType?: string;
  targetId?: string;
  outcome?: "success" | "denied" | "failure";
  requestId?: string;
  ipHash?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

export async function writeAudit(tx: TenantTx, e: AuditInput): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events
       (tenant_id, actor_user_id, actor_type, action, target_type, target_id, outcome, request_id, ip_hash, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      tx.tenantId,
      e.actorUserId ?? null,
      e.actorType,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      e.outcome ?? "success",
      e.requestId ?? null,
      e.ipHash ?? null,
      e.userAgent?.slice(0, 300) ?? null,
      JSON.stringify(e.metadata ?? {}),
    ],
  );
}

/** For events with no tenant (failed logins, denied cross-tenant attempts, webhooks). */
export async function writeSystemAudit(pool: Pool, tenantId: string | null, e: AuditInput): Promise<void> {
  await pool.query(
    `INSERT INTO audit_events
       (tenant_id, actor_user_id, actor_type, action, target_type, target_id, outcome, request_id, ip_hash, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      tenantId,
      e.actorUserId ?? null,
      e.actorType,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      e.outcome ?? "success",
      e.requestId ?? null,
      e.ipHash ?? null,
      e.userAgent?.slice(0, 300) ?? null,
      JSON.stringify(e.metadata ?? {}),
    ],
  );
}

export async function listAudit(tx: TenantTx, limit: number, before?: number) {
  const r = await tx.query<{
    id: string;
    actor_user_id: string | null;
    actor_type: string;
    action: string;
    target_type: string | null;
    target_id: string | null;
    outcome: string;
    request_id: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT id, actor_user_id, actor_type, action, target_type, target_id, outcome, request_id, metadata, created_at
       FROM audit_events WHERE tenant_id = $1 AND ($2::bigint IS NULL OR id < $2)
      ORDER BY id DESC LIMIT $3`,
    [tx.tenantId, before ?? null, limit],
  );
  return r.rows;
}

// ── Job idempotency ───────────────────────────────────────────────────────

/**
 * Claims a job run. Returns "completed" if this key already finished (skip),
 * otherwise records/increments a running attempt and returns "claimed".
 */
export async function claimJobRun(pool: Pool, key: string, queue: string): Promise<"claimed" | "completed"> {
  const r = await pool.query<{ status: string }>(
    `INSERT INTO job_runs (idempotency_key, queue, status, attempts)
     VALUES ($1, $2, 'running', 1)
     ON CONFLICT (idempotency_key) DO UPDATE
       SET attempts = job_runs.attempts + 1,
           status = CASE WHEN job_runs.status = 'completed' THEN 'completed' ELSE 'running' END,
           started_at = CASE WHEN job_runs.status = 'completed' THEN job_runs.started_at ELSE now() END
     RETURNING status`,
    [key, queue],
  );
  return r.rows[0]!.status === "completed" ? "completed" : "claimed";
}

export async function completeJobRun(pool: Pool, key: string, result: unknown) {
  await pool.query(
    `UPDATE job_runs SET status = 'completed', completed_at = now(), result = $2::jsonb, last_error = NULL
      WHERE idempotency_key = $1`,
    [key, JSON.stringify(result ?? null)],
  );
}

export async function failJobRun(pool: Pool, key: string, error: string, deadLettered: boolean) {
  await pool.query(`UPDATE job_runs SET status = $3, last_error = $2 WHERE idempotency_key = $1`, [
    key,
    error.slice(0, 2_000),
    deadLettered ? "dead-lettered" : "failed",
  ]);
}

// ── Webhook de-duplication ────────────────────────────────────────────────

export async function recordWebhookReceipt(pool: Pool, provider: string, eventId: string): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO webhook_receipts (provider, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [provider, eventId],
  );
  return (r.rowCount ?? 0) === 1;
}

// ── Scheduling helpers (system scope) ─────────────────────────────────────

/** Farms with at least one enabled alert rule. Cross-tenant by design: used only to fan out per-tenant jobs. */
export async function farmsWithAlertRules(tx: SystemTx): Promise<{ tenant_id: string; farm_id: string }[]> {
  const r = await tx.query<{ tenant_id: string; farm_id: string }>(
    `SELECT DISTINCT tenant_id, farm_id FROM alert_rules WHERE enabled`,
  );
  return r.rows;
}

// ── Chain indexing (public data, system scope) ────────────────────────────

export interface ChainLog {
  chainId: number;
  contractAddress: string;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  eventName: string;
  args: Record<string, unknown>;
}

export async function getChainCursor(tx: SystemTx, chainId: number, contract: string) {
  const r = await tx.query<{ last_block_number: string; last_block_hash: string }>(
    `SELECT last_block_number, last_block_hash FROM chain_cursors WHERE chain_id = $1 AND contract_address = $2 FOR UPDATE`,
    [chainId, contract.toLowerCase()],
  );
  const row = r.rows[0];
  return row ? { blockNumber: BigInt(row.last_block_number), blockHash: row.last_block_hash } : undefined;
}

export async function setChainCursor(tx: SystemTx, chainId: number, contract: string, blockNumber: bigint, blockHash: string) {
  await tx.query(
    `INSERT INTO chain_cursors (chain_id, contract_address, last_block_number, last_block_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chain_id, contract_address)
       DO UPDATE SET last_block_number = EXCLUDED.last_block_number, last_block_hash = EXCLUDED.last_block_hash, updated_at = now()`,
    [chainId, contract.toLowerCase(), blockNumber.toString(), blockHash],
  );
}

export async function upsertChainLogs(tx: SystemTx, logs: ChainLog[], confirmed: boolean) {
  for (const l of logs) {
    await tx.query(
      `INSERT INTO chain_events (chain_id, contract_address, block_number, block_hash, tx_hash, log_index, event_name, args, confirmed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       ON CONFLICT (chain_id, tx_hash, log_index)
         DO UPDATE SET block_hash = EXCLUDED.block_hash, block_number = EXCLUDED.block_number,
                       confirmed = EXCLUDED.confirmed, removed = false`,
      [
        l.chainId,
        l.contractAddress.toLowerCase(),
        l.blockNumber.toString(),
        l.blockHash,
        l.txHash,
        l.logIndex,
        l.eventName,
        JSON.stringify(l.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
        confirmed,
      ],
    );
  }
}

/** Marks events at or above a block as removed after a reorg is detected. */
export async function markReorged(tx: SystemTx, chainId: number, contract: string, fromBlock: bigint) {
  const r = await tx.query(
    `UPDATE chain_events SET removed = true, confirmed = false
      WHERE chain_id = $1 AND contract_address = $2 AND block_number >= $3 AND NOT removed`,
    [chainId, contract.toLowerCase(), fromBlock.toString()],
  );
  return r.rowCount ?? 0;
}
