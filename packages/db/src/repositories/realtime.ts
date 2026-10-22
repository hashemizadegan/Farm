/**
 * Realtime outbox (migration 0030): durable, ordered `metafarm-event/1` envelopes per workspace. Writers append inside
 * the transaction that produced the fact, so an event exists exactly when its data does. Readers page by cursor
 * (`seq`) within one workspace. Payloads are validated against the event type before they are stored.
 */
import { parseEventEnvelope, type EventEnvelope, type EventType } from "@metafarm/domain";
import type { SystemTx, TenantTx } from "../tenant";

export interface RealtimeEventRow {
  seq: string;
  event: EventEnvelope;
}

interface Row {
  seq: string;
  id: string;
  tenant_id: string;
  farm_id: string | null;
  type: string;
  schema_version: number;
  payload: Record<string, unknown>;
  occurred_at: Date;
  correlation_id: string | null;
}

const toEnvelope = (r: Row): EventEnvelope =>
  parseEventEnvelope({
    scheme: "metafarm-event/1",
    type: r.type,
    schemaVersion: r.schema_version,
    id: r.id,
    scope: { tenantId: r.tenant_id, farmId: r.farm_id },
    occurredAt: new Date(r.occurred_at).toISOString(),
    correlationId: r.correlation_id,
    payload: r.payload,
  });

/**
 * Appends one event for the transaction's workspace. The envelope is validated (type, version, scope, payload) and
 * must name the transaction's workspace. A per-workspace transaction lock orders appends, so cursors become visible
 * in commit order (see the migration). Idempotent on the event id. Returns the cursor.
 */
export async function appendRealtimeEvent(tx: TenantTx, input: unknown, opts: { retentionDays?: number } = {}): Promise<string> {
  const e = parseEventEnvelope(input);
  if (e.scope.tenantId !== tx.tenantId) throw new Error("a realtime event must belong to the transaction's workspace");
  const days = opts.retentionDays ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("retention must be 1 to 90 days");
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('realtime_events:' || $1::text, 0))`, [tx.tenantId]);
  const r = await tx.query<{ seq: string }>(
    `INSERT INTO realtime_events (id, tenant_id, farm_id, type, schema_version, payload, occurred_at, correlation_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now() + make_interval(days => $9::int))
     ON CONFLICT (id) DO NOTHING
     RETURNING seq::text`,
    [e.id, tx.tenantId, e.scope.farmId, e.type, e.schemaVersion, JSON.stringify(e.payload), e.occurredAt, e.correlationId, days],
  );
  if (r.rows[0]) return r.rows[0].seq;
  const existing = await tx.query<{ seq: string }>(`SELECT seq::text FROM realtime_events WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, e.id]);
  if (!existing.rows[0]) throw new Error("realtime event id already used by another workspace");
  return existing.rows[0].seq;
}

/**
 * Events of the transaction's workspace after `after` (exclusive; null = none, i.e. from the start of retention),
 * restricted to `types` and, when `farmId` is given, to that farm. Ascending cursor order, at most `limit`.
 */
export async function listRealtimeEventsAfter(
  tx: TenantTx,
  q: { after: string | null; types: readonly EventType[]; farmId: string | null; limit: number },
): Promise<RealtimeEventRow[]> {
  const r = await tx.query<Row>(
    `SELECT seq::text, id, tenant_id, farm_id, type, schema_version, payload, occurred_at, correlation_id
       FROM realtime_events
      WHERE tenant_id = $1 AND seq > $2::bigint AND type = ANY($3::text[]) AND ($4::uuid IS NULL OR farm_id = $4::uuid)
      ORDER BY seq
      LIMIT $5`,
    [tx.tenantId, q.after ?? "0", q.types, q.farmId, q.limit],
  );
  return r.rows.map((row) => ({ seq: row.seq, event: toEnvelope(row) }));
}

/** The newest cursor of the workspace (null when it has no events): where a "from now" subscription starts. */
export async function latestRealtimeCursor(tx: TenantTx): Promise<string | null> {
  const r = await tx.query<{ seq: string | null }>(`SELECT max(seq)::text AS seq FROM realtime_events WHERE tenant_id = $1`, [tx.tenantId]);
  return r.rows[0]?.seq ?? null;
}

/** Retention (system role): deletes expired rows, oldest first, at most `limit` per call. Returns how many. */
export async function pruneRealtimeEvents(tx: SystemTx, limit = 10_000): Promise<number> {
  const r = await tx.query(
    `DELETE FROM realtime_events WHERE seq IN (SELECT seq FROM realtime_events WHERE expires_at <= now() ORDER BY seq LIMIT $1)`,
    [limit],
  );
  return r.rowCount ?? 0;
}
