/**
 * Registered integrations (migration 0031). Registration, rotation and revocation run in the workspace's own
 * transaction (application role); the ingestion route resolves an integration by id with the system role (the
 * caller is not a user yet), then works inside that integration's workspace only.
 */
import type { IntegrationKind } from "@metafarm/domain";
import type { SystemTx, TenantTx } from "../tenant";

export interface IntegrationRow {
  id: string;
  tenant_id: string;
  kind: IntegrationKind;
  provider: string;
  name: string;
  status: "active" | "revoked";
  secret_version: number;
  secret_sha256: string;
  allowed_event_types: string[];
  created_by: string;
  created_at: Date;
  rotated_at: Date | null;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

const COLUMNS = `id, tenant_id, kind, provider, name, status, secret_version, secret_sha256, allowed_event_types, created_by, created_at, rotated_at, last_seen_at, revoked_at`;

export async function insertIntegration(
  tx: TenantTx,
  input: { id: string; kind: IntegrationKind; provider: string; name: string; allowedEventTypes: string[]; secretSha256: string; createdBy: string },
): Promise<IntegrationRow> {
  const r = await tx.query<IntegrationRow>(
    `INSERT INTO integrations (id, tenant_id, kind, provider, name, allowed_event_types, secret_sha256, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8) RETURNING ${COLUMNS}`,
    [input.id, tx.tenantId, input.kind, input.provider, input.name, input.allowedEventTypes, input.secretSha256, input.createdBy],
  );
  return r.rows[0]!;
}

/** The workspace's integrations; with `farmId`, only those that have delivered observations to that farm. */
export async function listIntegrations(tx: TenantTx, opts: { farmId?: string } = {}): Promise<IntegrationRow[]> {
  const r = await tx.query<IntegrationRow>(
    `SELECT ${COLUMNS} FROM integrations i
      WHERE i.tenant_id = $1
        AND ($2::uuid IS NULL OR EXISTS (
          SELECT 1 FROM integration_events ie JOIN raw_observations r ON r.tenant_id = ie.tenant_id AND r.id = ANY(ie.raw_observation_ids)
           WHERE ie.tenant_id = i.tenant_id AND ie.integration_id = i.id AND r.farm_id = $2::uuid))
      ORDER BY i.created_at DESC, i.id`,
    [tx.tenantId, opts.farmId ?? null],
  );
  return r.rows;
}

export async function getIntegration(tx: TenantTx, id: string): Promise<IntegrationRow | undefined> {
  const r = await tx.query<IntegrationRow>(`SELECT ${COLUMNS} FROM integrations WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id]);
  return r.rows[0];
}

/** Moves an active integration to its next secret version. Returns the row, or undefined when absent or revoked. */
export async function rotateIntegrationSecret(tx: TenantTx, id: string, nextSecretSha256: (version: number) => string): Promise<IntegrationRow | undefined> {
  const cur = await tx.query<{ secret_version: number }>(`SELECT secret_version FROM integrations WHERE tenant_id = $1 AND id = $2 AND status = 'active' FOR UPDATE`, [tx.tenantId, id]);
  if (!cur.rows[0]) return undefined;
  const version = cur.rows[0].secret_version + 1;
  const r = await tx.query<IntegrationRow>(
    `UPDATE integrations SET secret_version = $3, secret_sha256 = $4, rotated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [tx.tenantId, id, version, nextSecretSha256(version)],
  );
  return r.rows[0];
}

/** Revokes an integration (final). Returns the row, or undefined when absent; an already revoked row is returned as is. */
export async function revokeIntegration(tx: TenantTx, id: string): Promise<{ row: IntegrationRow; changed: boolean } | undefined> {
  const r = await tx.query<IntegrationRow>(
    `UPDATE integrations SET status = 'revoked', revoked_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'active' RETURNING ${COLUMNS}`,
    [tx.tenantId, id],
  );
  if (r.rows[0]) return { row: r.rows[0], changed: true };
  const row = await getIntegration(tx, id);
  return row ? { row, changed: false } : undefined;
}

/** Ingestion: the integration by id, across workspaces (system role). The caller then works in `tenant_id` only. */
export async function getIntegrationForIngest(tx: SystemTx, id: string): Promise<IntegrationRow | undefined> {
  const r = await tx.query<IntegrationRow>(`SELECT ${COLUMNS} FROM integrations WHERE id = $1`, [id]);
  return r.rows[0];
}

/**
 * Records an accepted provider event (idempotency key: integration + provider event id) and marks the integration as
 * heard from. Returns false when the event was already recorded: the caller must then store nothing.
 */
export async function recordIntegrationEvent(
  tx: TenantTx,
  input: { integrationId: string; providerEventId: string; eventType: string; payloadSha256: string; rawObservationIds: string[] },
): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO integration_events (integration_id, provider_event_id, tenant_id, event_type, payload_sha256, raw_observation_ids)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[]) ON CONFLICT DO NOTHING`,
    [input.integrationId, input.providerEventId, tx.tenantId, input.eventType, input.payloadSha256, input.rawObservationIds],
  );
  if ((r.rowCount ?? 0) === 0) return false;
  await tx.query(`UPDATE integrations SET last_seen_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, input.integrationId]);
  return true;
}

/** Whether the provider event was already accepted (checked before any observation is written). */
export async function integrationEventSeen(tx: TenantTx, integrationId: string, providerEventId: string): Promise<boolean> {
  const r = await tx.query(`SELECT 1 FROM integration_events WHERE tenant_id = $1 AND integration_id = $2 AND provider_event_id = $3`, [tx.tenantId, integrationId, providerEventId]);
  return (r.rowCount ?? 0) > 0;
}
