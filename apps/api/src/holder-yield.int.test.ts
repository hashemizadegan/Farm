/**
 * Y13: a member sees their own party's allocations only through an active account link (D-29), only from published
 * simulation cycles' approved sets; never other parties', unattributed or dust rows; off by default.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  addYieldAttestation,
  authorisePartyLink,
  consentPartyLink,
  createFarm,
  createParty,
  createPool,
  createTenantWithOwner,
  createYieldCycle,
  migrateUp,
  proposePartyLink,
  recordCalculation,
  revokePartyLink,
  setYieldCycleParameters,
  transitionYieldCycle,
  upsertUserBySubject,
  withSystem,
  withTenant,
  type Pool,
} from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";
import { frozenNoLeaves, testArtifact } from "./test/yield-calc";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const MINT = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const h = (c: string) => c.repeat(64);

d("holder-facing yield allocations (Y13)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let linksOff: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const who = (n: string) => `hy-${n}-${sfx}`;
  const ids: Record<string, string> = {};
  let tenantId: string;
  let mine: string;
  let theirs: string;
  let linkId: string;
  let cycleId: string;

  const get = async (as: string, on = app) => on.inject({ method: "GET", url: `/v1/tenants/${tenantId}/me/yield/allocations`, headers: { authorization: `Bearer ${await tokenFor(who(as))}` } });

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const n of ["owner", "admin", "holder", "other"]) ids[n] = (await upsertUserBySubject(pool, { issuer: "dev", subject: who(n) })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `hy-${sfx}`, name: "Holders", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'viewer'), ($1, $4, 'viewer')`, [tenantId, ids.admin, ids.holder, ids.other]);
    ({ mine, theirs, linkId, cycleId } = await withTenant(pool, tenantId, async (tx) => {
      const farm = (await createFarm(tx, { name: "Grove", timezone: "UTC", createdBy: ids.owner! })).id;
      const asset = (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'farm_share', 'Shares') RETURNING id`, [tx.tenantId, farm])).rows[0]!.id;
      const mine = await createParty(tx, { kind: "person", displayName: "Mine", createdBy: ids.owner! });
      const theirs = await createParty(tx, { kind: "person", displayName: "Theirs", createdBy: ids.owner! });
      const link = await proposePartyLink(tx, { partyId: mine, userId: ids.holder!, proposedBy: ids.owner! });
      await consentPartyLink(tx, link.id, { userId: ids.holder!, consentVersion: "draft-unapproved-1", consentSha256: h("c") });
      await authorisePartyLink(tx, link.id, ids.admin!);
      const c = await createYieldCycle(tx, { businessAssetId: asset, periodStart: "2026-01-01", periodEnd: "2026-03-31", network: "solana-devnet", rail: "SOLANA_TOKEN_2022", chainAssetId: MINT, createdBy: ids.owner! });
      await setYieldCycleParameters(tx, c.id, { entitlementRef: h("a"), policyHash: h("b"), formulaVersion: "f1", accountingCurrency: "EUR", settlementMint: MINT, settlementDecimals: 6 }, ids.owner!);
      await transitionYieldCycle(tx, c.id, { to: "inputs_locked", actorUserId: ids.owner! });
      await setYieldCycleParameters(tx, c.id, { slotStart: 1n, slotEnd: 2n }, ids.owner!);
      const r = await recordCalculation(tx, c.id, {
        calculationHash: h("1"), allocationHash: h("2"), evidenceBundleHash: h("3"), merkleRoot: h("4"), ...frozenNoLeaves("a"),
        snapshot: { sourceKind: "fixture", sourceIdentityId: null, cursorSlot: 2n, holdingModel: "slot_weighted", inputCommitment: h("6"), totalWeight: 100n },
        allocations: [
          { kind: "allocated", partyId: mine, weight: 60n, amount: 600n },
          { kind: "allocated", partyId: theirs, weight: 30n, amount: 300n },
          { kind: "unattributed", holderKey: MINT, weight: 10n, amount: 100n },
        ],
        actorUserId: ids.owner!,
      });
      await transitionYieldCycle(tx, c.id, { to: "under_review", actorUserId: ids.owner! });
      await addYieldAttestation(tx, { artifactSetId: r.artifactSetId, attesterUserId: ids.admin!, kind: "attest", attestedHash: testArtifact("a").setHash, statement: "ok" });
      return { mine, theirs, linkId: link.id, cycleId: c.id };
    }));
    ({ app } = await buildTestApp({ pool, env: { HOLDER_YIELD_ENABLED: "true", PARTY_LINKS_ENABLED: "true" } }));
    ({ app: linksOff } = await buildTestApp({ pool, env: { HOLDER_YIELD_ENABLED: "true" } }));
  });
  afterAll(async () => {
    await Promise.all([app?.close(), linksOff?.close()]);
    await pool?.end();
  });

  it("is off unless both flags are on", async () => {
    expect((await get("holder", linksOff)).statusCode).toBe(404);
  });

  it("shows nothing before publication, then only the linked party's own allocation", async () => {
    expect((await get("holder")).json()).toMatchObject({ linked: true, items: [] });
    await withTenant(pool, tenantId, async (tx) => {
      await transitionYieldCycle(tx, cycleId, { to: "approved", actorUserId: ids.admin! });
      await transitionYieldCycle(tx, cycleId, { to: "published", actorUserId: ids.admin! });
    });
    const body = (await get("holder")).json();
    expect(body).toMatchObject({ linked: true, disclosureApproved: false, proofs: "per_cycle" });
    expect(body.items).toEqual([expect.objectContaining({ cycleId, kind: "allocated", amount: "600", weight: "60", simulation: true, payoutsPaused: false })]);
    expect(JSON.stringify(body)).not.toContain(theirs);
    expect(JSON.stringify(body)).not.toContain(mine); // the party id itself is not echoed either
    // A member without a link sees nothing, whatever their role.
    expect((await get("other")).json()).toMatchObject({ linked: false, items: [] });
    expect((await get("owner")).json()).toMatchObject({ linked: false, items: [] });
  });

  it("pauses on dispute and stops at once when the link is revoked", async () => {
    await withTenant(pool, tenantId, (tx) => transitionYieldCycle(tx, cycleId, { to: "disputed", actorUserId: ids.admin!, reason: "query" }));
    expect((await get("holder")).json().items[0]).toMatchObject({ status: "disputed", payoutsPaused: true });
    await withTenant(pool, tenantId, (tx) => revokePartyLink(tx, linkId, { revokedBy: ids.holder!, asUser: ids.holder! }));
    expect((await get("holder")).json()).toMatchObject({ linked: false, items: [] });
  });
});
