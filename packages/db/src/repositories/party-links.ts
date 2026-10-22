/**
 * Y12 (D-29): the explicit, consented, authorised, revocable and audited link between a login and an RWA party
 * (migration 0025). The database enforces the steps, four-eyes and the append-only event log; this module maps its
 * refusals to PartyLinkError codes and writes audit events. Nothing here creates, derives or edits a party, and
 * parties.user_id is never read.
 */
import type { TenantTx } from "../tenant";
import { writeAudit } from "./ops";

export const PARTY_LINK_ERROR_CODES = ["not_found", "not_member", "forbidden", "duplicate", "four_eyes", "self_proposed", "invalid_transition", "immutable", "consent_mismatch", "invalid_input"] as const;
export type PartyLinkErrorCode = (typeof PARTY_LINK_ERROR_CODES)[number];

export class PartyLinkError extends Error {
  constructor(
    readonly code: PartyLinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PartyLinkError";
  }
}

export function toPartyLinkError(err: unknown): unknown {
  const e = err as { code?: string; hint?: string; constraint?: string; message?: string };
  if (typeof e?.code !== "string") return err;
  const message = e.message ?? "refused";
  if (e.hint?.startsWith("link:")) {
    const c = e.hint.slice(5);
    if ((PARTY_LINK_ERROR_CODES as readonly string[]).includes(c)) return new PartyLinkError(c as PartyLinkErrorCode, message);
  }
  if (e.constraint === "party_account_links_four_eyes") return new PartyLinkError("four_eyes", message);
  if (e.constraint === "party_account_links_not_self_proposed") return new PartyLinkError("self_proposed", message);
  if (e.code === "23505") return new PartyLinkError("duplicate", message);
  if (e.code === "23503") return new PartyLinkError("not_found", message);
  if (e.code === "42501") return new PartyLinkError("forbidden", message);
  if (e.code === "23514" || e.code === "22P02") return new PartyLinkError("invalid_input", message);
  return err;
}

async function step<T>(tx: TenantTx, fn: () => Promise<T>): Promise<T> {
  await tx.query("SAVEPOINT party_link");
  try {
    const r = await fn();
    await tx.query("RELEASE SAVEPOINT party_link");
    return r;
  } catch (err) {
    await tx.query("ROLLBACK TO SAVEPOINT party_link");
    throw toPartyLinkError(err);
  }
}

export type PartyLinkStatus = "proposed" | "consented" | "active" | "revoked";

export interface PartyLinkRow {
  id: string;
  partyId: string;
  userId: string;
  status: PartyLinkStatus;
  proposedBy: string;
  proposedAt: Date;
  consentVersion: string | null;
  consentSha256: string | null;
  consentedAt: Date | null;
  authorisedBy: string | null;
  authorisedAt: Date | null;
  revokedBy: string | null;
  revokedAt: Date | null;
  revocationReason: string | null;
}

const SELECT = `SELECT id, party_id, user_id, status, proposed_by, proposed_at, consent_version, consent_sha256, consented_at, authorised_by, authorised_at,
  revoked_by, revoked_at, revocation_reason FROM party_account_links`;

type Db = {
  id: string;
  party_id: string;
  user_id: string;
  status: PartyLinkStatus;
  proposed_by: string;
  proposed_at: Date;
  consent_version: string | null;
  consent_sha256: string | null;
  consented_at: Date | null;
  authorised_by: string | null;
  authorised_at: Date | null;
  revoked_by: string | null;
  revoked_at: Date | null;
  revocation_reason: string | null;
};

const toRow = (r: Db): PartyLinkRow => ({
  id: r.id,
  partyId: r.party_id,
  userId: r.user_id,
  status: r.status,
  proposedBy: r.proposed_by,
  proposedAt: r.proposed_at,
  consentVersion: r.consent_version,
  consentSha256: r.consent_sha256,
  consentedAt: r.consented_at,
  authorisedBy: r.authorised_by,
  authorisedAt: r.authorised_at,
  revokedBy: r.revoked_by,
  revokedAt: r.revoked_at,
  revocationReason: r.revocation_reason,
});

export async function getPartyLink(tx: TenantTx, id: string, forUpdate = false): Promise<PartyLinkRow | undefined> {
  const r = await tx.query<Db>(`${SELECT} WHERE tenant_id = $1 AND id = $2${forUpdate ? " FOR UPDATE" : ""}`, [tx.tenantId, id]);
  return r.rows[0] ? toRow(r.rows[0]) : undefined;
}

/** An operator proposes linking a named, existing party to a member of this workspace. */
export async function proposePartyLink(tx: TenantTx, p: { partyId: string; userId: string; proposedBy: string }): Promise<PartyLinkRow> {
  const member = await tx.query(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tx.tenantId, p.userId]);
  if (!member.rowCount) throw new PartyLinkError("not_member", "the account to link is not a member of this workspace");
  const id = await step(tx, async () => {
    const r = await tx.query<{ id: string }>(`INSERT INTO party_account_links (tenant_id, party_id, user_id, proposed_by) VALUES ($1, $2, $3, $4) RETURNING id`, [tx.tenantId, p.partyId, p.userId, p.proposedBy]);
    return r.rows[0]!.id;
  });
  await writeAudit(tx, { actorUserId: p.proposedBy, actorType: "user", action: "party_link.propose", targetType: "party_account_link", targetId: id, metadata: { partyId: p.partyId, userId: p.userId } });
  return (await getPartyLink(tx, id))!;
}

/** The linked user accepts the consent text they were shown (its version and SHA-256 are recorded). */
export async function consentPartyLink(tx: TenantTx, id: string, c: { userId: string; consentVersion: string; consentSha256: string }): Promise<PartyLinkRow> {
  const link = await getPartyLink(tx, id, true);
  if (!link || link.userId !== c.userId) throw new PartyLinkError("not_found", "no such link for this account");
  await step(tx, () =>
    tx.query(`UPDATE party_account_links SET status = 'consented', consent_version = $3, consent_sha256 = $4, consented_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id, c.consentVersion, c.consentSha256]),
  );
  await writeAudit(tx, { actorUserId: c.userId, actorType: "user", action: "party_link.consent", targetType: "party_account_link", targetId: id, metadata: { consentVersion: c.consentVersion } });
  return (await getPartyLink(tx, id))!;
}

/** A second operator (never the proposer nor the linked user) authorises a consented link. */
export async function authorisePartyLink(tx: TenantTx, id: string, authorisedBy: string): Promise<PartyLinkRow> {
  if (!(await getPartyLink(tx, id, true))) throw new PartyLinkError("not_found", "no such link");
  await step(tx, () => tx.query(`UPDATE party_account_links SET status = 'active', authorised_by = $3, authorised_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id, authorisedBy]));
  await writeAudit(tx, { actorUserId: authorisedBy, actorType: "user", action: "party_link.authorise", targetType: "party_account_link", targetId: id });
  return (await getPartyLink(tx, id))!;
}

/** Revokes a live link (terminal). `asUser` limits it to the linked user's own link. */
export async function revokePartyLink(tx: TenantTx, id: string, r: { revokedBy: string; reason?: string; asUser?: string }): Promise<PartyLinkRow> {
  const link = await getPartyLink(tx, id, true);
  if (!link || (r.asUser !== undefined && link.userId !== r.asUser)) throw new PartyLinkError("not_found", "no such link");
  await step(tx, () =>
    tx.query(`UPDATE party_account_links SET status = 'revoked', revoked_by = $3, revoked_at = now(), revocation_reason = $4 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id, r.revokedBy, r.reason ?? null]),
  );
  await writeAudit(tx, { actorUserId: r.revokedBy, actorType: "user", action: "party_link.revoke", targetType: "party_account_link", targetId: id, metadata: r.reason ? { reason: r.reason } : {} });
  return (await getPartyLink(tx, id))!;
}

export async function listPartyLinks(tx: TenantTx, partyId: string): Promise<PartyLinkRow[]> {
  return (await tx.query<Db>(`${SELECT} WHERE tenant_id = $1 AND party_id = $2 ORDER BY proposed_at DESC, id DESC`, [tx.tenantId, partyId])).rows.map(toRow);
}

export async function listUserPartyLinks(tx: TenantTx, userId: string): Promise<PartyLinkRow[]> {
  return (await tx.query<Db>(`${SELECT} WHERE tenant_id = $1 AND user_id = $2 ORDER BY proposed_at DESC, id DESC`, [tx.tenantId, userId])).rows.map(toRow);
}

/**
 * The party a signed-in user may act for in this workspace: only through an active link (D-29). Null otherwise —
 * never derived from parties.user_id, wallets or a login.
 */
export async function activePartyOfUser(tx: TenantTx, userId: string): Promise<string | null> {
  const r = await tx.query<{ party_id: string }>(`SELECT party_id FROM party_account_links WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [tx.tenantId, userId]);
  return r.rows[0]?.party_id ?? null;
}

export async function listPartyLinkEvents(tx: TenantTx, linkId: string): Promise<{ event: string; actorId: string; detail: unknown; at: Date }[]> {
  const r = await tx.query<{ event: string; actor_id: string; detail: unknown; at: Date }>(`SELECT event, actor_id, detail, at FROM party_account_link_events WHERE tenant_id = $1 AND link_id = $2 ORDER BY id`, [tx.tenantId, linkId]);
  return r.rows.map((x) => ({ event: x.event, actorId: x.actor_id, detail: x.detail, at: x.at }));
}
