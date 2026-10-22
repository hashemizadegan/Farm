/**
 * Y8: the operator read API for yield cycles (plan §7.3; D-28 permissions). Read-only: GET only.
 *
 * - `yield:read`: cycles, a cycle with its artifact sets, ownership snapshots and attestation counts, the
 *   transition history, and an artifact set's allocations (party ids and holder keys: operators only).
 * - `audit:read`: the audit events about a cycle (D-31: audit_events).
 *
 * The public summary (`/v1/public/yield/...`, plan §7.4) is deliberately not registered: it waits for D-30.
 * Holder-facing endpoints wait for D-29 (Y12/Y13). Nothing here contacts a chain.
 */
import type { FastifyInstance } from "fastify";
import {
  InvalidCursorError,
  activeYieldAttesters,
  getYieldCycle,
  getYieldOwnershipSnapshot,
  listYieldAllocations,
  listYieldArtifactSets,
  listYieldCycleTransitions,
  listYieldCycles,
  toPage,
  type TenantTx,
  type YieldCycleRow,
} from "@metafarm/db";
import { uuid } from "@metafarm/domain";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";

const STATUSES = ["draft", "inputs_locked", "calculated", "under_review", "approved", "published", "funded", "distributing", "disputed", "closed", "cancelled", "abandoned", "superseded"] as const;
const tenantParams = z.object({ tenantId: uuid });
const cycleParams = tenantParams.extend({ cycleId: uuid });
const setParams = cycleParams.extend({ setId: uuid });
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: uuid.optional(),
    status: z.enum(STATUSES).optional(),
    simulation: z.enum(["true", "false"]).optional(),
  })
  .strict();

const iso = (d: Date) => d.toISOString();

/** The operator view of a cycle. Bigints travel as decimal strings. */
export const toYieldCycle = (c: YieldCycleRow) => ({
  id: c.id,
  businessAssetId: c.businessAssetId,
  period: { start: c.periodStart, end: c.periodEnd },
  version: c.version,
  simulation: c.simulation,
  status: c.status,
  priorStatus: c.priorStatus,
  closeReason: c.closeReason,
  chainAsset: { network: c.network, rail: c.rail, id: c.chainAssetId },
  entitlementRef: c.entitlementRef,
  policyHash: c.policyHash,
  formulaVersion: c.formulaVersion,
  accountingCurrency: c.accountingCurrency,
  settlement: c.settlementMint === null ? null : { mint: c.settlementMint, decimals: c.settlementDecimals },
  slotRange: c.slotStart === null || c.slotEnd === null ? null : { start: c.slotStart.toString(), end: c.slotEnd.toString() },
  artifactSetHash: c.artifactSetHash,
  merkleRoot: c.merkleRoot,
  preparedBy: c.preparedBy,
  createdBy: c.createdBy,
  createdAt: iso(c.createdAt),
  updatedAt: iso(c.updatedAt),
});

export async function yieldCycleDetail(tx: TenantTx, cycleId: string) {
  const cycle = await getYieldCycle(tx, cycleId);
  if (!cycle) throw notFound("yield cycle");
  const sets = await listYieldArtifactSets(tx, cycleId);
  return {
    ...toYieldCycle(cycle),
    artifactSets: await Promise.all(
      sets.map(async (s) => {
        const snap = await getYieldOwnershipSnapshot(tx, s.id);
        return {
          id: s.id,
          setNumber: s.setNumber,
          status: s.status,
          hashes: { calculation: s.calculationHash, allocation: s.allocationHash, evidenceBundle: s.evidenceBundleHash, merkleRoot: s.merkleRoot, set: s.setHash },
          ownershipSnapshot: snap
            ? {
                sourceKind: snap.sourceKind,
                sourceIdentityId: snap.sourceIdentityId,
                network: snap.network,
                slotRange: { start: snap.slotStart.toString(), end: snap.slotEnd.toString() },
                cursorSlot: snap.cursorSlot.toString(),
                holdingModel: snap.holdingModel,
                inputCommitment: snap.inputCommitment,
                totalWeight: snap.totalWeight.toString(),
              }
            : null,
          attesters: (await activeYieldAttesters(tx, s.id)).length,
          createdAt: iso(s.createdAt),
        };
      }),
    ),
  };
}

export async function yieldRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/yield/cycles", async (req) => {
    parse(tenantParams, req.params);
    const q = parse(listQuery, req.query);
    return app.inTenant(req, "yield:read", async (tx) => {
      let rows: YieldCycleRow[];
      try {
        rows = await listYieldCycles(tx, { limit: q.limit, after: q.cursor }, { status: q.status, simulation: q.simulation === undefined ? undefined : q.simulation === "true" });
      } catch (e) {
        if (e instanceof InvalidCursorError) throw new HttpError(400, "invalid_cursor", "the cursor does not name an item of this list");
        throw e;
      }
      const page = toPage(rows, q.limit);
      return { items: page.rows.map(toYieldCycle), nextCursor: page.nextCursor };
    });
  });

  app.get("/v1/tenants/:tenantId/yield/cycles/:cycleId", async (req) => {
    const { cycleId } = parse(cycleParams, req.params);
    return app.inTenant(req, "yield:read", (tx) => yieldCycleDetail(tx, cycleId));
  });

  app.get("/v1/tenants/:tenantId/yield/cycles/:cycleId/transitions", async (req) => {
    const { cycleId } = parse(cycleParams, req.params);
    return app.inTenant(req, "yield:read", async (tx) => {
      if (!(await getYieldCycle(tx, cycleId))) throw notFound("yield cycle");
      const items = await listYieldCycleTransitions(tx, cycleId);
      return { items: items.map((t) => ({ command: t.command, from: t.fromState, to: t.toState, actorUserId: t.actorUserId, reason: t.reason, artifactSetHash: t.artifactSetHash, at: iso(t.at) })) };
    });
  });

  app.get("/v1/tenants/:tenantId/yield/cycles/:cycleId/artifact-sets/:setId/allocations", async (req) => {
    const { cycleId, setId } = parse(setParams, req.params);
    return app.inTenant(req, "yield:read", async (tx) => {
      const sets = await listYieldArtifactSets(tx, cycleId);
      if (!sets.some((s) => s.id === setId)) throw notFound("artifact set");
      const items = await listYieldAllocations(tx, setId);
      return {
        items: items.map((a) => ({ kind: a.kind, partyId: a.partyId ?? null, holderKey: a.holderKey ?? null, weight: a.weight.toString(), amount: a.amount.toString() })),
      };
    });
  });

  app.get("/v1/tenants/:tenantId/yield/cycles/:cycleId/audit", async (req) => {
    const { cycleId } = parse(cycleParams, req.params);
    return app.inTenant(req, "audit:read", async (tx) => {
      if (!(await getYieldCycle(tx, cycleId))) throw notFound("yield cycle");
      const r = await tx.query<{ id: string; actor_user_id: string | null; actor_type: string; action: string; outcome: string; metadata: unknown; created_at: Date }>(
        `SELECT id::text, actor_user_id, actor_type, action, outcome, metadata, created_at FROM audit_events
          WHERE tenant_id = $1 AND target_type = 'yield_cycle' AND target_id = $2 ORDER BY id LIMIT 1000`,
        [tx.tenantId, cycleId],
      );
      return { items: r.rows.map((e) => ({ id: e.id, actorUserId: e.actor_user_id, actorType: e.actor_type, action: e.action, outcome: e.outcome, metadata: e.metadata, at: iso(e.created_at) })) };
    });
  });
}
