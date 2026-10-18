import type { Role } from "@metafarm/domain";
import type { Pool } from "../pool";
import type { SystemTx, TenantTx } from "../tenant";

export interface MemberRow {
  user_id: string;
  role: Role;
  display_name: string | null;
  email: string | null;
  joined_at: string;
}

export async function listMembers(tx: TenantTx): Promise<MemberRow[]> {
  const r = await tx.query<MemberRow>(
    `SELECT m.user_id, m.role, u.display_name, u.email::text AS email, m.created_at AS joined_at
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND (m.expires_at IS NULL OR m.expires_at > now())
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 WHEN 'verifier' THEN 3 WHEN 'worker' THEN 4 ELSE 5 END,
               lower(coalesce(u.display_name, u.email, '')), m.created_at`,
    [tx.tenantId],
  );
  return r.rows;
}

export async function getMemberRole(tx: TenantTx, userId: string): Promise<Role | undefined> {
  const r = await tx.query<{ role: Role }>(`SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tx.tenantId, userId]);
  return r.rows[0]?.role;
}

/** Owners in the workspace, locked so concurrent changes cannot remove the last one. */
export async function countOwnersForUpdate(tx: TenantTx): Promise<number> {
  const r = await tx.query(`SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'owner' FOR UPDATE`, [tx.tenantId]);
  return r.rowCount ?? 0;
}

export async function setMemberRole(tx: TenantTx, userId: string, role: Role): Promise<void> {
  await tx.query(`UPDATE memberships SET role = $3 WHERE tenant_id = $1 AND user_id = $2`, [tx.tenantId, userId, role]);
}

export async function removeMember(tx: TenantTx, userId: string): Promise<void> {
  await tx.query(`DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tx.tenantId, userId]);
}

/** The app role can only read tenants, so renaming runs with system access after the permission check. */
export async function renameTenant(tx: SystemTx, tenantId: string, name: string): Promise<{ id: string; slug: string; name: string }> {
  const r = await tx.query<{ id: string; slug: string; name: string }>(
    `UPDATE tenants SET name = $2, updated_at = now() WHERE id = $1 RETURNING id, slug, name`,
    [tenantId, name],
  );
  return r.rows[0]!;
}

// ── Invitations ───────────────────────────────────────────────────────────

export interface InvitationRow {
  id: string;
  email: string;
  role: Role;
  invited_by: string | null;
  invited_by_name: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const INVITE_COLUMNS = `i.id, i.email::text AS email, i.role, i.invited_by, coalesce(u.display_name, u.email::text) AS invited_by_name,
  i.expires_at, i.accepted_at, i.revoked_at, i.created_at`;

export async function createInvitation(
  tx: TenantTx,
  input: { email: string; role: Role; tokenHash: string; invitedBy: string; ttlHours: number },
): Promise<InvitationRow> {
  const r = await tx.query<InvitationRow>(
    `WITH i AS (
       INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))
       RETURNING *
     )
     SELECT ${INVITE_COLUMNS} FROM i LEFT JOIN users u ON u.id = i.invited_by`,
    [tx.tenantId, input.email, input.role, input.tokenHash, input.invitedBy, input.ttlHours],
  );
  return r.rows[0]!;
}

/** Pending (not accepted, not revoked, not expired) invitations, newest first. */
export async function listPendingInvitations(tx: TenantTx): Promise<InvitationRow[]> {
  const r = await tx.query<InvitationRow>(
    `SELECT ${INVITE_COLUMNS} FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.tenant_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
      ORDER BY i.created_at DESC`,
    [tx.tenantId],
  );
  return r.rows;
}

export async function revokeInvitation(tx: TenantTx, id: string): Promise<boolean> {
  const r = await tx.query(
    `UPDATE invitations SET revoked_at = now() WHERE tenant_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [tx.tenantId, id],
  );
  return (r.rowCount ?? 0) > 0;
}

export type AcceptOutcome =
  | { ok: true; tenantId: string; tenantName: string; role: Role; alreadyMember: boolean }
  | { ok: false; reason: "invalid" | "expired" | "used" };

/**
 * Accepts an invitation by token hash. Runs with system access because the
 * caller is not yet a member. Single use: the row is locked and marked
 * accepted in the same transaction. An existing member keeps their role.
 */
export async function acceptInvitation(tx: SystemTx, tokenHash: string, userId: string): Promise<AcceptOutcome> {
  const r = await tx.query<{ id: string; tenant_id: string; role: Role; expires_at: string; accepted_at: string | null; revoked_at: string | null; name: string }>(
    `SELECT i.id, i.tenant_id, i.role, i.expires_at, i.accepted_at, i.revoked_at, t.name
       FROM invitations i JOIN tenants t ON t.id = i.tenant_id
      WHERE i.token_hash = $1 FOR UPDATE OF i`,
    [tokenHash],
  );
  const inv = r.rows[0];
  if (!inv || inv.revoked_at) return { ok: false, reason: "invalid" };
  if (inv.accepted_at) return { ok: false, reason: "used" };
  if (new Date(inv.expires_at).getTime() <= Date.now()) return { ok: false, reason: "expired" };

  const existing = await tx.query<{ role: Role }>(`SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [inv.tenant_id, userId]);
  if (!existing.rows[0]) {
    await tx.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [inv.tenant_id, userId, inv.role]);
  }
  await tx.query(`UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1`, [inv.id, userId]);
  return {
    ok: true,
    tenantId: inv.tenant_id,
    tenantName: inv.name,
    role: existing.rows[0]?.role ?? inv.role,
    alreadyMember: Boolean(existing.rows[0]),
  };
}

/** Self-reported profile details shown to other members. Not verified. */
export async function updateProfile(pool: Pool, userId: string, input: { displayName?: string | null; email?: string | null }) {
  const r = await pool.query<{ display_name: string | null; email: string | null }>(
    `UPDATE users SET
        display_name = CASE WHEN $2::boolean THEN $3 ELSE display_name END,
        email = CASE WHEN $4::boolean THEN $5::citext ELSE email END,
        updated_at = now()
      WHERE id = $1 RETURNING display_name, email::text AS email`,
    [userId, input.displayName !== undefined, input.displayName ?? null, input.email !== undefined, input.email ?? null],
  );
  return r.rows[0];
}

// ── Workspace settings ────────────────────────────────────────────────────

export interface TenantSettingsRow {
  id: string;
  slug: string;
  name: string;
  settings: Record<string, unknown>;
  /** The oldest active farm's time zone: the workspace's clock for weekly summaries. */
  timezone: string | null;
}

const SETTINGS_SELECT = `
  SELECT t.id, t.slug, t.name, t.settings,
         (SELECT f.timezone FROM farms f WHERE f.tenant_id = t.id AND f.archived_at IS NULL ORDER BY f.created_at LIMIT 1) AS timezone
    FROM tenants t`;

export async function getTenantSettings(tx: SystemTx, tenantId: string): Promise<TenantSettingsRow | undefined> {
  const r = await tx.query<TenantSettingsRow>(`${SETTINGS_SELECT} WHERE t.id = $1`, [tenantId]);
  return r.rows[0];
}

/** Workspaces with at least one active farm, for the weekly summary sweep. */
export async function listTenantsWithFarms(tx: SystemTx, limit = 5000): Promise<TenantSettingsRow[]> {
  const r = await tx.query<TenantSettingsRow>(
    `${SETTINGS_SELECT} WHERE EXISTS (SELECT 1 FROM farms f WHERE f.tenant_id = t.id AND f.archived_at IS NULL) ORDER BY t.id LIMIT $1`,
    [limit],
  );
  return r.rows;
}

/** Merges keys into tenants.settings. */
export async function mergeTenantSettings(tx: SystemTx, tenantId: string, patch: Record<string, unknown>): Promise<void> {
  await tx.query(`UPDATE tenants SET settings = settings || $2::jsonb, updated_at = now() WHERE id = $1`, [tenantId, JSON.stringify(patch)]);
}
