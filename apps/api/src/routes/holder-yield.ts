/**
 * Y13 (plan §7.3 holder-facing, §8): a signed-in member's own allocations, only through an active account-to-party
 * link (D-29, Y12) — never by login, wallet or parties.user_id. Read-only, simulation cycles only, published (or
 * disputed) cycles from their approved artifact set; unattributed and dust rows never shown.
 *
 * Off unless HOLDER_YIELD_ENABLED and PARTY_LINKS_ENABLED (404); refused in staging and production by configuration
 * (D-39 holder disclosures, D-15, D-25, D-27 open).
 *
 * Proofs (after the line join): `GET …/me/yield/cycles/{cycleId}/proof` serves the member's party's **persisted**
 * leaf and proof from the cycle's approved set (migration 0027), re-verified against the set's root before it is
 * served; nothing is recomputed. These are simulation leaves under the simulation hasher (D-26 open).
 * Unsigned claim intents are not built: they wait for D-15, D-25, D-27 and D-39.
 */
import type { FastifyInstance } from "fastify";
import { activePartyOfUser, getYieldClaimLeafOfParty, listPartyYieldAllocations, listYieldArtifactSets } from "@metafarm/db";
import { uuid } from "@metafarm/domain";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";
import { assertStoredProof, toLeafView } from "./yield";

const tenantParams = z.object({ tenantId: uuid });
const cycleParams = tenantParams.extend({ cycleId: uuid });

export async function holderYieldRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/me/yield/allocations", async (req) => {
    parse(tenantParams, req.params);
    const { env } = app.deps;
    if (!env.HOLDER_YIELD_ENABLED || !env.PARTY_LINKS_ENABLED) throw new HttpError(404, "not_found", "route not found");
    // Every member holds farm:read; what they see depends only on their own active link.
    return app.inTenant(req, "farm:read", async (tx) => {
      const partyId = await activePartyOfUser(tx, req.user!.id);
      if (!partyId) return { linked: false, items: [], proofs: "per_cycle", disclosureApproved: false };
      const rows = await listPartyYieldAllocations(tx, partyId, { simulationOnly: true });
      return {
        linked: true,
        disclosureApproved: false,
        // Each cycle's proof: GET …/me/yield/cycles/{cycleId}/proof (persisted, simulation leaves; D-26 open).
        proofs: "per_cycle",
        items: rows.map((r) => ({
          cycleId: r.cycleId,
          period: { start: r.periodStart, end: r.periodEnd },
          version: r.version,
          simulation: r.simulation,
          status: r.status,
          payoutsPaused: r.status === "disputed",
          kind: r.kind,
          weight: r.weight.toString(),
          amount: r.amount.toString(),
          settlement: r.settlementMint === null ? null : { mint: r.settlementMint, decimals: r.settlementDecimals },
          verification: { artifactSetId: r.artifactSetId, setHash: r.setHash, merkleRoot: r.merkleRoot },
        })),
      };
    });
  });

  app.get("/v1/tenants/:tenantId/me/yield/cycles/:cycleId/proof", async (req) => {
    const { cycleId } = parse(cycleParams, req.params);
    const { env } = app.deps;
    if (!env.HOLDER_YIELD_ENABLED || !env.PARTY_LINKS_ENABLED) throw new HttpError(404, "not_found", "route not found");
    return app.inTenant(req, "farm:read", async (tx) => {
      const partyId = await activePartyOfUser(tx, req.user!.id);
      if (!partyId) throw notFound("proof");
      // Only an allocation the member's party can see (published or disputed simulation cycle, approved set).
      const row = (await listPartyYieldAllocations(tx, partyId, { simulationOnly: true })).find((r) => r.cycleId === cycleId);
      if (!row) throw notFound("proof");
      if (row.kind !== "allocated") throw new HttpError(404, "no_leaf", "this allocation is withheld: it has no claim leaf");
      const set = (await listYieldArtifactSets(tx, cycleId)).find((s) => s.id === row.artifactSetId);
      const leaf = await getYieldClaimLeafOfParty(tx, row.artifactSetId, partyId);
      if (!set || !leaf) throw new HttpError(404, "no_leaf", "no persisted claim leaf for this allocation");
      await assertStoredProof(leaf, set.merkleRoot);
      const { partyId: _p, ...view } = toLeafView(leaf);
      return { cycleId, simulation: row.simulation, disclosureApproved: false, setHash: set.setHash, root: set.merkleRoot, leaf: view, hasherPending: "D-26" };
    });
  });
}
