/**
 * Y12 (D-29): account-to-party links. Explicit (an operator proposes a named party and member), consented (the
 * member accepts the consent text, recorded by version and SHA-256), authorised (a second operator, never the
 * proposer or the member), revocable (the member or an operator, at any time) and audited.
 *
 * Off unless PARTY_LINKS_ENABLED (404); refused in production by configuration. A link never creates or derives a
 * party. The consent text below is a working draft, NOT legally approved (D-39): it says so, and so does the API.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  PartyLinkError,
  authorisePartyLink,
  consentPartyLink,
  getParty,
  listPartyLinkEvents,
  listPartyLinks,
  listUserPartyLinks,
  proposePartyLink,
  revokePartyLink,
  type PartyLinkRow,
  type TenantTx,
} from "@metafarm/db";
import { uuid, type Permission } from "@metafarm/domain";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";

export const PARTY_LINK_CONSENT = {
  version: "draft-unapproved-1",
  approved: false,
  text:
    "I ask that my account be linked to the investor record named here, so that I can see that investor's own records in this workspace. " +
    "I understand that the link can be revoked by me or by the workspace at any time, that it does not create or change the investor record, " +
    "and that it does not by itself entitle me to any payment. [Working draft: this wording has not been legally approved.]",
} as const;
export const PARTY_LINK_CONSENT_SHA256 = createHash("sha256").update(PARTY_LINK_CONSENT.text, "utf8").digest("hex");

const iso = (d: Date | null) => (d ? d.toISOString() : null);
export const toPartyLink = (l: PartyLinkRow) => ({
  id: l.id,
  partyId: l.partyId,
  userId: l.userId,
  status: l.status,
  proposedBy: l.proposedBy,
  proposedAt: l.proposedAt.toISOString(),
  consent: l.consentedAt ? { version: l.consentVersion, sha256: l.consentSha256, at: iso(l.consentedAt) } : null,
  authorisedBy: l.authorisedBy,
  authorisedAt: iso(l.authorisedAt),
  revokedBy: l.revokedBy,
  revokedAt: iso(l.revokedAt),
  revocationReason: l.revocationReason,
});

const STATUS: Partial<Record<string, number>> = { not_found: 404, forbidden: 403, four_eyes: 403, self_proposed: 422, not_member: 422, invalid_input: 422, consent_mismatch: 422 };

const tenantParams = z.object({ tenantId: uuid });
const partyParams = tenantParams.extend({ partyId: uuid });
const linkParams = tenantParams.extend({ linkId: uuid });
const proposeSchema = z.object({ userId: uuid }).strict();
const consentSchema = z.object({ consentVersion: z.string().min(1).max(64), consentSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const revokeSchema = z.object({ reason: z.string().trim().min(1).max(2000).optional() }).strict();

export async function partyLinkRoutes(app: FastifyInstance) {
  const run = async <T>(req: FastifyRequest, permission: Permission, fn: (tx: TenantTx, userId: string) => Promise<T>): Promise<T> => {
    if (!app.deps.env.PARTY_LINKS_ENABLED) throw new HttpError(404, "not_found", "route not found");
    try {
      return await app.inTenant(req, permission, (tx) => fn(tx, req.user!.id));
    } catch (e) {
      if (e instanceof PartyLinkError) throw new HttpError(STATUS[e.code] ?? 409, e.code, e.message);
      throw e;
    }
  };

  app.post("/v1/tenants/:tenantId/rwa/parties/:partyId/account-links", async (req, reply) => {
    const { partyId } = parse(partyParams, req.params);
    const b = parse(proposeSchema, req.body);
    const out = await run(req, "rwa:operate", async (tx, userId) => {
      if (!(await getParty(tx, partyId))) throw notFound("party");
      return toPartyLink(await proposePartyLink(tx, { partyId, userId: b.userId, proposedBy: userId }));
    });
    return reply.status(201).send(out);
  });

  app.get("/v1/tenants/:tenantId/rwa/parties/:partyId/account-links", async (req) => {
    const { partyId } = parse(partyParams, req.params);
    return run(req, "rwa:read", async (tx) => {
      if (!(await getParty(tx, partyId))) throw notFound("party");
      const links = await listPartyLinks(tx, partyId);
      return { items: await Promise.all(links.map(async (l) => ({ ...toPartyLink(l), events: (await listPartyLinkEvents(tx, l.id)).map((e) => ({ ...e, at: e.at.toISOString() })) }))) };
    });
  });

  app.post("/v1/tenants/:tenantId/rwa/account-links/:linkId/authorise", async (req) => {
    const { linkId } = parse(linkParams, req.params);
    return run(req, "compliance:review", async (tx, userId) => toPartyLink(await authorisePartyLink(tx, linkId, userId)));
  });

  app.post("/v1/tenants/:tenantId/rwa/account-links/:linkId/revoke", async (req) => {
    const { linkId } = parse(linkParams, req.params);
    const b = parse(revokeSchema, req.body ?? {});
    return run(req, "rwa:operate", async (tx, userId) => toPartyLink(await revokePartyLink(tx, linkId, { revokedBy: userId, reason: b.reason })));
  });

  // The signed-in member's own links ("farm:read": every member of the workspace holds it).
  app.get("/v1/tenants/:tenantId/me/party-links", async (req) => {
    parse(tenantParams, req.params);
    return run(req, "farm:read", async (tx, userId) => ({
      consent: { ...PARTY_LINK_CONSENT, sha256: PARTY_LINK_CONSENT_SHA256 },
      items: (await listUserPartyLinks(tx, userId)).map(toPartyLink),
    }));
  });

  app.post("/v1/tenants/:tenantId/me/party-links/:linkId/consent", async (req) => {
    const { linkId } = parse(linkParams, req.params);
    const b = parse(consentSchema, req.body);
    return run(req, "farm:read", async (tx, userId) => {
      if (b.consentVersion !== PARTY_LINK_CONSENT.version || b.consentSha256 !== PARTY_LINK_CONSENT_SHA256)
        throw new PartyLinkError("consent_mismatch", "consent must be given to the current consent text (version and SHA-256)");
      return toPartyLink(await consentPartyLink(tx, linkId, { userId, consentVersion: b.consentVersion, consentSha256: b.consentSha256 }));
    });
  });

  app.post("/v1/tenants/:tenantId/me/party-links/:linkId/revoke", async (req) => {
    const { linkId } = parse(linkParams, req.params);
    const b = parse(revokeSchema, req.body ?? {});
    return run(req, "farm:read", async (tx, userId) => toPartyLink(await revokePartyLink(tx, linkId, { revokedBy: userId, reason: b.reason, asUser: userId })));
  });
}
