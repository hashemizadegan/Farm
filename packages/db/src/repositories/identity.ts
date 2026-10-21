import type { Role } from "@metafarm/domain";
import type { Pool } from "../pool";
import type { SystemTx, TenantTx } from "../tenant";

export interface UserRow {
  id: string;
  oidc_issuer: string;
  oidc_subject: string;
  email: string | null;
  display_name: string | null;
}

/**
 * Users are global (one person may belong to several tenants), so lookup by
 * OIDC subject happens outside a tenant transaction.
 */
export async function upsertUserBySubject(
  pool: Pool,
  claims: { issuer: string; subject: string; email?: string; name?: string },
): Promise<UserRow> {
  const r = await pool.query<UserRow>(
    `INSERT INTO users (oidc_issuer, oidc_subject, email, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (oidc_issuer, oidc_subject)
       DO UPDATE SET email = COALESCE(EXCLUDED.email, users.email),
                     display_name = COALESCE(EXCLUDED.display_name, users.display_name)
     RETURNING id, oidc_issuer, oidc_subject, email, display_name`,
    [claims.issuer, claims.subject, claims.email ?? null, claims.name ?? null],
  );
  return r.rows[0]!;
}

/**
 * Resolves the caller's role in a tenant. Runs with system access because it is
 * the check that decides whether a tenant context may be opened at all.
 */
export async function findMembershipRole(pool: Pool, tenantId: string, userId: string): Promise<Role | undefined> {
  const r = await pool.query<{ role: Role }>(
    `SELECT role FROM memberships
      WHERE tenant_id = $1 AND user_id = $2 AND (expires_at IS NULL OR expires_at > now())`,
    [tenantId, userId],
  );
  return r.rows[0]?.role;
}

export async function listUserTenants(pool: Pool, userId: string) {
  const r = await pool.query<{ tenant_id: string; slug: string; name: string; role: Role }>(
    `SELECT t.id AS tenant_id, t.slug, t.name, m.role
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND (m.expires_at IS NULL OR m.expires_at > now())
      ORDER BY t.name`,
    [userId],
  );
  return r.rows;
}

export async function countOwnedTenants(tx: SystemTx, userId: string): Promise<number> {
  const r = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM memberships WHERE user_id = $1 AND role = 'owner'`, [userId]);
  return Number(r.rows[0]!.n);
}

export async function createTenantWithOwner(tx: SystemTx, input: { slug: string; name: string; ownerUserId: string }) {
  const t = await tx.query<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [
    input.slug,
    input.name,
  ]);
  const tenantId = t.rows[0]!.id;
  await tx.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [tenantId, input.ownerUserId]);
  return tenantId;
}

export async function recordConsent(
  tx: TenantTx,
  input: { userId: string; kind: string; version: string; granted: boolean; ipHash?: string },
) {
  await tx.query(
    `INSERT INTO consents (tenant_id, user_id, kind, version, granted, ip_hash) VALUES ($1, $2, $3, $4, $5, $6)`,
    [tx.tenantId, input.userId, input.kind, input.version, input.granted, input.ipHash ?? null],
  );
}

// ── Wallet linking ────────────────────────────────────────────────────────

