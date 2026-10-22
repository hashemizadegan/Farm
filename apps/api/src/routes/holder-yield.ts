/**
 * Y13 (plan §7.3 holder-facing, §8): a signed-in member's own allocations, only through an active account-to-party
 * link (D-29, Y12) — never by login, wallet or parties.user_id. Read-only, simulation cycles only, published (or
 * disputed) cycles from their approved artifact set; unattributed and dust rows never shown.
 *
 * Off unless HOLDER_YIELD_ENABLED and PARTY_LINKS_ENABLED (404); refused in staging and production by configuration
 * (D-39 holder disclosures, D-15, D-25, D-27 open).
 *
 * Not built here, and why: Merkle proofs and unsigned claim intents are over the canonical leaf data, which is the
 * final Y6 (D-26, pending the [Ext] on-chain cost check) on the yield line. Until that exists here they are not
 * offered; there is no fallback.
 */
import type { FastifyInstance } from "fastify";
import { activePartyOfUser, listPartyYieldAllocations } from "@metafarm/db";
import { uuid } from "@metafarm/domain";
import { z } from "zod";
import { HttpError, parse } from "../lib/http";

const tenantParams = z.object({ tenantId: uuid });

export async function holderYieldRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/me/yield/allocations", async (req) => {
    parse(tenantParams, req.params);
    const { env } = app.deps;
    if (!env.HOLDER_YIELD_ENABLED || !env.PARTY_LINKS_ENABLED) throw new HttpError(404, "not_found", "route not found");
    // Every member holds farm:read; what they see depends only on their own active link.
    return app.inTenant(req, "farm:read", async (tx) => {
      const partyId = await activePartyOfUser(tx, req.user!.id);
      if (!partyId) return { linked: false, items: [], proofs: "unavailable", disclosureApproved: false };
      const rows = await listPartyYieldAllocations(tx, partyId, { simulationOnly: true });
      return {
        linked: true,
        disclosureApproved: false,
        // Proofs and claim intents need the final canonical leaves (Y6, D-26): not available on this line.
        proofs: "unavailable",
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
}
