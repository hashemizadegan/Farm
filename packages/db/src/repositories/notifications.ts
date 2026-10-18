import type { NotificationKind, Role } from "@metafarm/domain";
import type { TenantTx } from "../tenant";

/** Creates a notification for each person once per dedupe key; returns how many were new. */
export async function notify(tx: TenantTx, userIds: string[], kind: NotificationKind, data: object, dedupeKey: string): Promise<number> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return 0;
  const r = await tx.query(
    `INSERT INTO notifications (tenant_id, user_id, kind, data, dedupe_key)
     SELECT $1, u, $3, $4::jsonb, $5 FROM unnest($2::uuid[]) AS u
     ON CONFLICT (tenant_id, user_id, dedupe_key) DO NOTHING`,
    [tx.tenantId, ids, kind, JSON.stringify(data), dedupeKey.slice(0, 200)],
  );
  return r.rowCount ?? 0;
}

export async function membersWithRoles(tx: TenantTx, roles: Role[]): Promise<string[]> {
  const r = await tx.query<{ user_id: string }>(
    `SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = ANY($2::text[]) AND (expires_at IS NULL OR expires_at > now())`,
    [tx.tenantId, roles],
  );
  return r.rows.map((x) => x.user_id);
}

export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export async function listNotifications(tx: TenantTx, userId: string, unreadOnly: boolean, limit: number) {
  const [items, count] = await Promise.all([
    tx.query<NotificationRow>(
      `SELECT id, kind, data, read_at, created_at FROM notifications
        WHERE tenant_id = $1 AND user_id = $2 AND ($3 = false OR read_at IS NULL)
        ORDER BY created_at DESC LIMIT $4`,
      [tx.tenantId, userId, unreadOnly, limit],
    ),
    tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`, [tx.tenantId, userId]),
  ]);
  return { items: items.rows, unread: count.rows[0]?.n ?? 0 };
}

export async function markNotificationsRead(tx: TenantTx, userId: string, ids: string[] | "all"): Promise<number> {
  const r =
    ids === "all"
      ? await tx.query(`UPDATE notifications SET read_at = now() WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`, [tx.tenantId, userId])
      : await tx.query(`UPDATE notifications SET read_at = now() WHERE tenant_id = $1 AND user_id = $2 AND id = ANY($3::uuid[]) AND read_at IS NULL`, [
          tx.tenantId,
          userId,
          ids,
        ]);
  return r.rowCount ?? 0;
}

/** Keeps the table small: read notifications older than 90 days go. */
export async function pruneNotifications(tx: TenantTx) {
  await tx.query(`DELETE FROM notifications WHERE tenant_id = $1 AND read_at < now() - interval '90 days'`, [tx.tenantId]);
}
