import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { findMembershipRole, upsertUserBySubject, withTenant, writeAudit, writeSystemAudit, type AuditInput, type TenantTx } from "@metafarm/db";
import { can, type Permission, type Role } from "@metafarm/domain";
import { AuthError } from "../auth/provider";
import type { Deps } from "../deps";
import { HttpError, forbidden, hashIp, notFound, unauthorized } from "../lib/http";

export interface AuthedUser {
  id: string;
  issuer: string;
  subject: string;
  displayName: string | null;
}

export interface TenantContext {
  id: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthedUser;
    tenant?: TenantContext;
  }
  interface FastifyInstance {
    deps: Deps;
    authenticate: (req: FastifyRequest) => Promise<void>;
    /** Resolves `:tenantId`, enforces membership + permission, then runs `fn` in a tenant-bound transaction. */
    inTenant: <T>(req: FastifyRequest, permission: Permission, fn: (tx: TenantTx, ctx: TenantContext) => Promise<T>) => Promise<T>;
    audit: (req: FastifyRequest, tx: TenantTx, e: Omit<AuditInput, "actorType" | "requestId" | "ipHash" | "userAgent">) => Promise<void>;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const contextPlugin = fp(async (app: FastifyInstance, opts: { deps: Deps }) => {
  app.decorate("deps", opts.deps);

  app.decorate("authenticate", async (req: FastifyRequest) => {
    if (req.user) return;
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    if (!token || token.length > 8_192) throw unauthorized();
    try {
      const identity = await opts.deps.auth.verify(token);
      const user = await upsertUserBySubject(opts.deps.pool, {
        issuer: identity.issuer,
        subject: identity.subject,
        email: identity.email,
        name: identity.name,
      });
      req.user = { id: user.id, issuer: user.oidc_issuer, subject: user.oidc_subject, displayName: user.display_name };
    } catch (err) {
      if (err instanceof AuthError) {
        await writeSystemAudit(opts.deps.pool, null, {
          actorType: "user",
          action: "auth.token_rejected",
          outcome: "denied",
          requestId: req.id,
          ipHash: hashIp(req.ip),
          userAgent: req.headers["user-agent"],
        }).catch(() => undefined);
        throw unauthorized();
      }
      throw err;
    }
  });

  app.decorate(
    "inTenant",
    async <T>(req: FastifyRequest, permission: Permission, fn: (tx: TenantTx, ctx: TenantContext) => Promise<T>) => {
      await app.authenticate(req);
      const tenantId = (req.params as { tenantId?: string }).tenantId;
      if (!tenantId || !UUID.test(tenantId)) throw notFound("tenant");
      const role = await findMembershipRole(opts.deps.pool, tenantId, req.user!.id);
      if (!role) {
        // Do not reveal whether the tenant exists. Record the attempt.
        await writeSystemAudit(opts.deps.pool, null, {
          actorType: "user",
          actorUserId: req.user!.id,
          action: "tenant.access_denied",
          targetType: "tenant",
          targetId: tenantId,
          outcome: "denied",
          requestId: req.id,
          ipHash: hashIp(req.ip),
        }).catch(() => undefined);
        throw notFound("tenant");
      }
      const ctx = { id: tenantId, role };
      req.tenant = ctx;
      if (!can(role, permission)) {
        await withTenant(opts.deps.pool, tenantId, (tx) =>
          app.audit(req, tx, { actorUserId: req.user!.id, action: "permission.denied", outcome: "denied", metadata: { permission } }),
        ).catch(() => undefined);
        throw forbidden();
      }
      return withTenant(opts.deps.pool, tenantId, (tx) => fn(tx, ctx));
    },
  );

  app.decorate("audit", async (req: FastifyRequest, tx: TenantTx, e: Omit<AuditInput, "actorType" | "requestId" | "ipHash" | "userAgent">) => {
    await writeAudit(tx, {
      ...e,
      actorType: "user",
      actorUserId: e.actorUserId ?? req.user?.id ?? null,
      requestId: req.id,
      ipHash: hashIp(req.ip),
      userAgent: req.headers["user-agent"],
    });
  });
});

export { HttpError };
