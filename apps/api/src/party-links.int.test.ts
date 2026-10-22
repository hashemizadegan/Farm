/**
 * Y12 (D-29): account-to-party links against a real database. Explicit, consented, authorised (four-eyes),
 * revocable, audited; never creates or derives a party; off by default.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { activePartyOfUser, createParty, createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, withTenant, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";
import { PARTY_LINK_CONSENT, PARTY_LINK_CONSENT_SHA256 } from "./routes/party-links";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("account-to-party links (Y12)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let off: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const who = (n: string) => `pl-${n}-${sfx}`;
  const ids: Record<string, string> = {};
  let tenantId: string;
  let partyId: string;
  let otherParty: string;

  const call = async (method: "GET" | "POST", path: string, as: string, payload?: object, on = app) =>
    on.inject({ method, url: `/v1/tenants/${tenantId}${path}`, headers: { authorization: `Bearer ${await tokenFor(who(as))}` }, ...(payload ? { payload } : {}) });
  const consent = { consentVersion: PARTY_LINK_CONSENT.version, consentSha256: PARTY_LINK_CONSENT_SHA256 };

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const n of ["owner", "admin", "holder", "viewer", "outsider"]) ids[n] = (await upsertUserBySubject(pool, { issuer: "dev", subject: who(n) })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `pl-${sfx}`, name: "Links", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'viewer'), ($1, $4, 'viewer')`, [tenantId, ids.admin, ids.holder, ids.viewer]);
    ({ partyId, otherParty } = await withTenant(pool, tenantId, async (tx) => ({
      partyId: await createParty(tx, { kind: "person", displayName: "Investor", createdBy: ids.owner! }),
      otherParty: await createParty(tx, { kind: "person", displayName: "Other", createdBy: ids.owner! }),
    })));
    ({ app } = await buildTestApp({ pool, env: { PARTY_LINKS_ENABLED: "true" } }));
    ({ app: off } = await buildTestApp({ pool }));
  });
  afterAll(async () => {
    await Promise.all([app?.close(), off?.close()]);
    await pool?.end();
  });

  it("is off by default", async () => {
    expect((await call("GET", "/me/party-links", "holder", undefined, off)).statusCode).toBe(404);
    expect((await call("POST", `/rwa/parties/${partyId}/account-links`, "owner", { userId: ids.holder }, off)).statusCode).toBe(404);
  });

  it("goes proposed → consented → active only with the member's consent and a second operator, and is audited", async () => {
    const parties = async () => (await pool.query(`SELECT count(*)::int AS n FROM parties WHERE tenant_id = $1`, [tenantId])).rows[0].n;
    const before = await parties();
    expect((await call("POST", `/rwa/parties/${partyId}/account-links`, "viewer", { userId: ids.holder })).statusCode).toBe(403);
    expect((await call("POST", `/rwa/parties/${partyId}/account-links`, "owner", { userId: ids.outsider })).json().error).toBe("not_member");
    const p = await call("POST", `/rwa/parties/${partyId}/account-links`, "owner", { userId: ids.holder });
    expect(p.statusCode, p.body).toBe(201);
    const linkId = p.json().id as string;
    expect((await call("POST", `/rwa/parties/${otherParty}/account-links`, "owner", { userId: ids.holder })).json().error).toBe("duplicate");

    // Not active yet: nothing may act for the party.
    expect(await withTenant(pool, tenantId, (tx) => activePartyOfUser(tx, ids.holder!))).toBeNull();
    expect((await call("POST", `/rwa/account-links/${linkId}/authorise`, "admin")).json().error).toBe("invalid_transition");

    const mine = (await call("GET", "/me/party-links", "holder")).json();
    expect(mine.consent).toMatchObject({ version: PARTY_LINK_CONSENT.version, approved: false, sha256: PARTY_LINK_CONSENT_SHA256 });
    expect(mine.items.map((l: { id: string }) => l.id)).toEqual([linkId]);
    expect((await call("POST", `/me/party-links/${linkId}/consent`, "viewer", consent)).statusCode).toBe(404);
    expect((await call("POST", `/me/party-links/${linkId}/consent`, "holder", { ...consent, consentSha256: "0".repeat(64) })).json().error).toBe("consent_mismatch");
    expect((await call("POST", `/me/party-links/${linkId}/consent`, "holder", consent)).json().status).toBe("consented");

    const self = await call("POST", `/rwa/account-links/${linkId}/authorise`, "owner");
    expect([self.statusCode, self.json().error]).toEqual([403, "four_eyes"]);
    expect((await call("POST", `/rwa/account-links/${linkId}/authorise`, "admin")).json().status).toBe("active");
    expect(await withTenant(pool, tenantId, (tx) => activePartyOfUser(tx, ids.holder!))).toBe(partyId);

    const listed = (await call("GET", `/rwa/parties/${partyId}/account-links`, "admin")).json().items[0];
    expect(listed.events.map((e: { event: string }) => e.event)).toEqual(["proposed", "consented", "authorised"]);
    expect(listed.consent).toMatchObject({ version: PARTY_LINK_CONSENT.version, sha256: PARTY_LINK_CONSENT_SHA256 });
    const audit = await pool.query<{ action: string }>(`SELECT action FROM audit_events WHERE tenant_id = $1 AND target_id = $2 ORDER BY id`, [tenantId, linkId]);
    expect(audit.rows.map((r) => r.action)).toEqual(["party_link.propose", "party_link.consent", "party_link.authorise"]);
    expect(await parties()).toBe(before); // no party was created or derived

    // The member revokes their own link; it is terminal, and acting for the party stops at once.
    expect((await call("POST", `/me/party-links/${linkId}/revoke`, "viewer", {})).statusCode).toBe(404);
    expect((await call("POST", `/me/party-links/${linkId}/revoke`, "holder", { reason: "no longer an investor" })).json().status).toBe("revoked");
    expect(await withTenant(pool, tenantId, (tx) => activePartyOfUser(tx, ids.holder!))).toBeNull();
    expect((await call("POST", `/rwa/account-links/${linkId}/authorise`, "admin")).json().error).toBe("invalid_transition");
    expect((await call("POST", `/rwa/account-links/${linkId}/revoke`, "owner", {})).json().error).toBe("invalid_transition");
  });

  it("lets an operator revoke at any step, and a new proposal start again", async () => {
    const id = (await call("POST", `/rwa/parties/${otherParty}/account-links`, "admin", { userId: ids.viewer })).json().id;
    expect((await call("POST", `/rwa/account-links/${id}/revoke`, "viewer", {})).statusCode).toBe(403);
    expect((await call("POST", `/rwa/account-links/${id}/revoke`, "owner", { reason: "proposed in error" })).json()).toMatchObject({ status: "revoked", revocationReason: "proposed in error" });
    expect((await call("POST", `/rwa/parties/${otherParty}/account-links`, "admin", { userId: ids.viewer })).statusCode).toBe(201);
  });
});
