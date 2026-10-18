import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  acceptInvitation,
  countOwnersForUpdate,
  createInvitation,
  getMemberRole,
  getTenantSettings,
  listMembers,
  listPendingInvitations,
  mergeTenantSettings,
  removeMember,
  renameTenant,
  revokeInvitation,
  setMemberRole,
  updateProfile,
  withSystem,
  withTenant,
  writeAudit,
  writeSystemAudit,
  type InvitationRow,
  type MemberRow,
  type TenantSettingsRow,
} from "@metafarm/db";
import {
  acceptInvitationSchema,
  createInvitationSchema,
  updateMemberSchema,
  readWorkspaceSettings,
  updateProfileSchema,
  uuid,
  workspaceSettingsSchema,
  type Role,
} from "@metafarm/domain";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";

const INVITE_TTL_HOURS = 7 * 24;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const toMember = (m: MemberRow) => ({
  userId: m.user_id,
  role: m.role,
  displayName: m.display_name,
  email: m.email,
  joinedAt: new Date(m.joined_at).toISOString(),
});

const toInvitation = (i: InvitationRow) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  invitedBy: i.invited_by_name,
  expiresAt: new Date(i.expires_at).toISOString(),
  createdAt: new Date(i.created_at).toISOString(),
});

/**
 * Role-change rules on top of member:manage:
 * - only an owner may make someone an owner, or change/remove an owner;
 * - the last owner can never be demoted or removed (the workspace would be unmanageable).
 */
function assertMayChange(callerRole: Role, targetRole: Role, newRole?: Role) {
  if ((targetRole === "owner" || newRole === "owner") && callerRole !== "owner") {
    throw new HttpError(403, "owner_required", "only an owner can grant, change or remove the owner role");
  }
}

export async function teamRoutes(app: FastifyInstance) {
  const memberParams = z.object({ tenantId: uuid, userId: uuid });

  app.get("/v1/tenants/:tenantId/members", async (req) =>
    app.inTenant(req, "farm:read", async (tx) => ({ items: (await listMembers(tx)).map(toMember) })),
  );

  app.patch("/v1/tenants/:tenantId/members/:userId", async (req) => {
    const { userId } = parse(memberParams, req.params);
    const { role } = parse(updateMemberSchema, req.body);
    return app.inTenant(req, "member:manage", async (tx, ctx) => {
      const current = await getMemberRole(tx, userId);
      if (!current) throw notFound("member");
      assertMayChange(ctx.role, current, role);
      if (current === "owner" && role !== "owner" && (await countOwnersForUpdate(tx)) <= 1) {
        throw new HttpError(409, "last_owner", "a workspace needs at least one owner; make someone else an owner first");
      }
      if (current !== role) {
        await setMemberRole(tx, userId, role);
        await app.audit(req, tx, { action: "member.role_changed", targetType: "user", targetId: userId, metadata: { from: current, to: role } });
      }
      return { userId, role };
    });
  });

  /** Removes a member. Members may also remove themselves (leave), subject to the last-owner rule. */
  app.delete("/v1/tenants/:tenantId/members/:userId", async (req, reply) => {
    const { userId } = parse(memberParams, req.params);
    await app.authenticate(req);
    const self = userId === req.user!.id;
    await app.inTenant(req, self ? "farm:read" : "member:manage", async (tx, ctx) => {
      const current = await getMemberRole(tx, userId);
      if (!current) throw notFound("member");
      if (!self) assertMayChange(ctx.role, current);
      if (current === "owner" && (await countOwnersForUpdate(tx)) <= 1) {
        throw new HttpError(409, "last_owner", "a workspace needs at least one owner; make someone else an owner first");
      }
      await removeMember(tx, userId);
      await app.audit(req, tx, { action: self ? "member.left" : "member.removed", targetType: "user", targetId: userId, metadata: { role: current } });
    });
    return reply.status(204).send();
  });

  app.get("/v1/tenants/:tenantId/invitations", async (req) =>
    app.inTenant(req, "member:manage", async (tx) => ({ items: (await listPendingInvitations(tx)).map(toInvitation) })),
  );

  /**
   * Creates a single-use invitation link valid for 7 days. The token is
   * returned once and only its hash is stored. Nothing is emailed: the admin
   * shares the link. Whoever opens it and signs in joins with the given role.
   */
  app.post("/v1/tenants/:tenantId/invitations", async (req, reply) => {
    const body = parse(createInvitationSchema, req.body);
    const token = randomBytes(24).toString("base64url");
    const inv = await app.inTenant(req, "member:manage", async (tx, ctx) => {
      if (body.role === "owner" && ctx.role !== "owner") {
        throw new HttpError(403, "owner_required", "only an owner can invite another owner");
      }
      const row = await createInvitation(tx, { ...body, tokenHash: hashToken(token), invitedBy: req.user!.id, ttlHours: INVITE_TTL_HOURS });
      await app.audit(req, tx, { action: "invitation.created", targetType: "invitation", targetId: row.id, metadata: { role: body.role } });
      return row;
    });
    return reply.status(201).send({ ...toInvitation(inv), token });
  });

  app.delete("/v1/tenants/:tenantId/invitations/:invitationId", async (req, reply) => {
    const { invitationId } = parse(z.object({ tenantId: uuid, invitationId: uuid }), req.params);
    await app.inTenant(req, "member:manage", async (tx) => {
      if (!(await revokeInvitation(tx, invitationId))) throw notFound("invitation");
      await app.audit(req, tx, { action: "invitation.revoked", targetType: "invitation", targetId: invitationId });
    });
    return reply.status(204).send();
  });

  app.post("/v1/me/invitations/accept", async (req) => {
    await app.authenticate(req);
    const { token } = parse(acceptInvitationSchema, req.body);
    const userId = req.user!.id;
    const outcome = await withSystem(app.deps.pool, (tx) => acceptInvitation(tx, hashToken(token), userId));
    if (!outcome.ok) {
      await writeSystemAudit(app.deps.pool, null, {
        actorType: "user",
        actorUserId: userId,
        action: "invitation.accept_failed",
        outcome: "failure",
        requestId: req.id,
        metadata: { reason: outcome.reason },
      });
      const messages = {
        invalid: "This invitation link is not valid. It may have been revoked; ask for a new one.",
        expired: "This invitation has expired. Ask for a new one.",
        used: "This invitation has already been used. Ask for a new one if you still need access.",
      } as const;
      throw new HttpError(outcome.reason === "invalid" ? 404 : 410, `invitation_${outcome.reason}`, messages[outcome.reason]);
    }
    await withTenant(app.deps.pool, outcome.tenantId, (tx) =>
      writeAudit(tx, {
        actorType: "user",
        actorUserId: userId,
        action: outcome.alreadyMember ? "invitation.accepted_existing_member" : "member.joined",
        targetType: "user",
        targetId: userId,
        requestId: req.id,
        metadata: { role: outcome.role },
      }),
    );
    return { tenantId: outcome.tenantId, name: outcome.tenantName, role: outcome.role, alreadyMember: outcome.alreadyMember };
  });

  const settingsView = (t: TenantSettingsRow) => ({ tenantId: t.id, slug: t.slug, name: t.name, ...readWorkspaceSettings(t.settings, t.timezone) });

  app.get("/v1/tenants/:tenantId/settings", async (req) => {
    const { tenantId } = parse(z.object({ tenantId: uuid }), req.params);
    return app.inTenant(req, "farm:read", async () => settingsView((await withSystem(app.deps.pool, (sys) => getTenantSettings(sys, tenantId)))!));
  });

  app.patch("/v1/tenants/:tenantId/settings", async (req) => {
    const { tenantId } = parse(z.object({ tenantId: uuid }), req.params);
    const body = parse(workspaceSettingsSchema, req.body);
    // inTenant checks membership and permission; the change itself needs system access (tenants is read-only to the app role).
    return app.inTenant(req, "member:manage", async (tx) => {
      const t = await withSystem(app.deps.pool, async (sys) => {
        if (body.name !== undefined) await renameTenant(sys, tenantId, body.name);
        if (body.weeklyReport) await mergeTenantSettings(sys, tenantId, { weeklyReport: body.weeklyReport });
        return (await getTenantSettings(sys, tenantId))!;
      });
      if (body.name !== undefined) await app.audit(req, tx, { action: "tenant.renamed", targetType: "tenant", targetId: tenantId, metadata: { name: body.name } });
      if (body.weeklyReport) await app.audit(req, tx, { action: "tenant.settings_changed", targetType: "tenant", targetId: tenantId, metadata: { weeklyReport: body.weeklyReport } });
      return settingsView(t);
    });
  });

  /** Name and email shown to other members. Self-reported, not verified. */
  app.patch("/v1/me/profile", async (req) => {
    await app.authenticate(req);
    const body = parse(updateProfileSchema, req.body);
    const p = await updateProfile(app.deps.pool, req.user!.id, body);
    return { displayName: p?.display_name ?? null, email: p?.email ?? null };
  });
}
