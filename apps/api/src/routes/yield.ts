/**
 * Y8: the operator read API for yield cycles (plan §7.3; D-28 permissions). Read-only: GET only.
 *
 * - `yield:read`: cycles, a cycle with its artifact sets, ownership snapshots and attestation counts, the
 *   transition history, and an artifact set's allocations (party ids and holder keys: operators only).
 * - `audit:read`: the audit events about a cycle (D-31: audit_events).
 *
 * Y9 (yieldWorkflowRoutes): the preparer and reviewer workflow for simulation cycles, behind YIELD_WORKFLOW_ENABLED
 * (off by default: 404). D-11: the freeze point is `calculate` (the documented recommendation). Disputes,
 * corrections, supersession and expiry are not exposed: they wait for D-22 (dispute authority) and D-10.
 *
 * The public summary (`/v1/public/yield/...`, plan §7.4) is deliberately not registered: it waits for D-30.
 * Holder-facing endpoints wait for D-29 (Y12/Y13). Nothing here contacts a chain.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  InvalidCursorError,
  OwnershipProvenanceError,
  YieldStoreError,
  activeYieldAttesters,
  addYieldAttestation,
  addYieldInput,
  createYieldCycle,
  getYieldCarry,
  latestSimulationDossier,
  listYieldClaimLeaves,
  yieldCarryIn,
  listYieldInputs,
  registerSimulationDossier,
  yieldInputEvidenceHashes,
  loadWeightedOwnershipInput,
  reconcileYieldCycle,
  recordCalculation,
  registerYieldEvidence,
  setYieldCycleParameters,
  transitionYieldCycle,
  type YieldClaimLeafRow,
  type YieldStoreErrorCode,
  type YieldTransitionRequest,
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
import { HoldingWeightError, uuid, type ChainAssetRef, type Permission } from "@metafarm/domain";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";
import { YieldEngineError, engineOutputProblems, type YieldCalculationRequest, type YieldCalculationResult } from "../lib/yield-engine";
import {
  CarryLedgerError,
  EMPTY_CARRY_LEDGER,
  SHA256_RFC9162_HASHER,
  SimulationDossierError,
  canonicalSimulationDossier,
  carryLedgerHash,
  parseCarryLedger,
  parseSimulationDossier,
  simulationDossierHash,
  verifyClaimLeafProof,
} from "@metafarm/domain/yield";

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

const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/** Fails closed if a stored leaf's proof does not verify against the set's root and the tree size. */
export async function assertStoredProof(l: YieldClaimLeafRow, root: string): Promise<void> {
  if (l.hasherId !== SHA256_RFC9162_HASHER.id) throw new HttpError(409, "proof_invalid", `leaf ${l.leafIndex} uses hasher ${l.hasherId}, which this service cannot verify`);
  const proof = { leafIndex: l.leafIndex, treeSize: l.treeSize, leafHash: l.leafHash, path: l.path, root: l.root };
  if (l.root !== root || !(await verifyClaimLeafProof(SHA256_RFC9162_HASHER, unhex(l.leafBytes), proof, { root, treeSize: l.treeSize })))
    throw new HttpError(409, "proof_invalid", `the stored proof of leaf ${l.leafIndex} does not verify`);
}

export const toLeafView = (l: YieldClaimLeafRow) => ({
  leafIndex: l.leafIndex,
  partyId: l.partyId,
  payoutWallet: l.payoutWallet,
  recipient: l.recipient,
  amount: l.amount.toString(),
  leafBytes: l.leafBytes,
  leafHash: l.leafHash,
  proof: { leafIndex: l.leafIndex, treeSize: l.treeSize, leafHash: l.leafHash, path: l.path, root: l.root },
  hasherId: l.hasherId,
});

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

  /**
   * A set's persisted claim leaves with their proofs (0027), operators only. Read from storage, never recomputed;
   * each proof is re-verified against the set's root and size, and a stored proof that fails is refused (409
   * proof_invalid), not served.
   */
  app.get("/v1/tenants/:tenantId/yield/cycles/:cycleId/artifact-sets/:setId/leaves", async (req) => {
    const { cycleId, setId } = parse(setParams, req.params);
    return app.inTenant(req, "yield:read", async (tx) => {
      const set = (await listYieldArtifactSets(tx, cycleId)).find((s) => s.id === setId);
      if (!set) throw notFound("artifact set");
      const leaves = await listYieldClaimLeaves(tx, setId);
      for (const l of leaves) await assertStoredProof(l, set.merkleRoot);
      return { root: set.merkleRoot, size: leaves.length, items: leaves.map(toLeafView) };
    });
  });

  /** A set's recorded carry-forward (0028): what it took in, from which predecessor, and what it carries out. */
  app.get("/v1/tenants/:tenantId/yield/cycles/:cycleId/artifact-sets/:setId/carry", async (req) => {
    const { cycleId, setId } = parse(setParams, req.params);
    return app.inTenant(req, "yield:read", async (tx) => {
      if (!(await listYieldArtifactSets(tx, cycleId)).some((s) => s.id === setId)) throw notFound("artifact set");
      const c = await getYieldCarry(tx, setId);
      if (!c) throw notFound("carry record");
      return { sourceSetId: c.sourceSetId, ledgerIn: { ...JSON.parse(c.ledgerIn.body), sha256: c.ledgerIn.sha256 }, ledgerOut: { ...JSON.parse(c.ledgerOut.body), sha256: c.ledgerOut.sha256 } };
    });
  });

  /** Y14: do the cycle's stored records agree with each other (read-only)? */
  app.get("/v1/tenants/:tenantId/yield/cycles/:cycleId/reconciliation", async (req) => {
    const { cycleId } = parse(cycleParams, req.params);
    return app.inTenant(req, "yield:read", async (tx) => {
      try {
        const r = await reconcileYieldCycle(tx, cycleId);
        return { ...r, consistent: r.findings.length === 0 };
      } catch (e) {
        if (e instanceof YieldStoreError && e.code === "not_found") throw notFound("yield cycle");
        throw e;
      }
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

// ── Y9: the preparer and reviewer workflow (simulation cycles) ──────────────

/**
 * Attestations an approval needs on a simulation cycle. Real cycles need an approved quorum record for the
 * asset class (D-23, open), so they are refused before this is consulted. A simulation-only default, not a policy.
 */
export const SIMULATION_ATTESTATION_QUORUM = 1;

const STATUS_OF: Partial<Record<YieldStoreErrorCode, number>> = {
  not_found: 404,
  forbidden: 403,
  four_eyes: 403,
  duplicate: 409,
  double_counted: 409,
  invalid_transition: 409,
  frozen: 409,
  immutable: 409,
  not_calculating: 409,
  artifact_set_changed: 409,
  future_phase: 409,
  real_gate: 409,
  cycle_not_draft: 409,
  artifact_missing: 409,
  artifact_mismatch: 409,
  carry_source_mismatch: 409,
  carry_source_missing: 409,
  carry_mismatch: 409,
  carry_predecessor_open: 409,
  carry_missing: 409,
};

/** Domain and store refusals as HTTP errors with their stable codes; anything else is rethrown. */
export function yieldHttpError(e: unknown): unknown {
  if (e instanceof YieldStoreError) return new HttpError(STATUS_OF[e.code] ?? 422, e.code, e.message);
  if (e instanceof HoldingWeightError) return new HttpError(e.code === "not_indexed" || e.code === "incomplete_history" ? 409 : 422, e.code, e.message);
  if (e instanceof OwnershipProvenanceError) return new HttpError(409, e.code, e.message);
  if (e instanceof YieldEngineError) return new HttpError(e.status, e.code, e.message);
  if (e instanceof SimulationDossierError) return new HttpError(422, e.code, e.message);
  if (e instanceof CarryLedgerError) return new HttpError(409, e.code, e.message);
  return e;
}

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "lowercase SHA-256 hex");
const b58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "a base58 address");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const slot = z.string().regex(/^\d{1,19}$/, "a slot number");
const reason = z.string().trim().min(1).max(2000);
const createCycleSchema = z
  .object({
    businessAssetId: uuid,
    periodStart: date,
    periodEnd: date,
    version: z.number().int().min(1).max(1_000_000).optional(),
    simulation: z.boolean().default(true),
    network: z.enum(["solana-devnet", "solana-mainnet"]),
    rail: z.enum(["SOLANA_TOKEN_2022", "SOLANA_BUBBLEGUM_CNFT"]),
    chainAssetId: b58,
  })
  .strict();
const parametersSchema = z
  .object({
    entitlementRef: hex64.optional(),
    policyHash: hex64.optional(),
    formulaVersion: z.string().regex(/^[a-z0-9][a-z0-9._:/-]{0,63}$/).optional(),
    accountingCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
    settlementMint: b58.optional(),
    settlementDecimals: z.number().int().min(0).max(18).optional(),
    slotStart: slot.optional(),
    slotEnd: slot.optional(),
  })
  .strict();
const evidenceSchema = z
  .object({ contentSha256: hex64, evidenceType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), classification: z.enum(["public", "internal", "confidential", "personal"]), supersedes: uuid.optional() })
  .strict();
const inputSchema = z
  .object({
    side: z.enum(["revenue", "expense"]),
    kind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    amount: z.string().regex(/^\d{1,78}$/, "a non-negative integer in minor units"),
    currency: z.string().regex(/^[A-Z]{3}$/),
    completeness: z.enum(["known", "zero", "estimated"]),
    evidenceId: uuid.optional(),
    sourceKind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    sourceRef: z.string().min(1).max(200),
  })
  .strict();
const reasonSchema = z.object({ reason: reason.optional() }).strict();
const closeSchema = z.object({ reason: z.enum(["no_distribution", "loss", "unfunded", "simulation"]), note: reason.optional() }).strict();
const cancelSchema = z.object({ reason }).strict();
const attestSchema = z.object({ artifactSetId: uuid, kind: z.enum(["attest", "revoke"]).default("attest"), attestedHash: hex64, statement: reason }).strict();

export async function yieldWorkflowRoutes(app: FastifyInstance) {
  const { env } = app.deps;
  const enabled = () => {
    if (!env.YIELD_WORKFLOW_ENABLED) throw new HttpError(404, "not_found", "route not found");
  };
  /** Runs `fn` in the tenant with `permission`, turning yield refusals into HTTP errors (nothing is changed). */
  const run = async <T>(req: FastifyRequest, permission: Permission, fn: (tx: TenantTx, userId: string) => Promise<T>): Promise<T> => {
    enabled();
    try {
      return await app.inTenant(req, permission, (tx) => fn(tx, req.user!.id));
    } catch (e) {
      throw yieldHttpError(e);
    }
  };
  /** Simulation cycles only: a real cycle cannot be worked on until its gates are approved (plan §2.1). */
  const simulationCycle = async (tx: TenantTx, cycleId: string, forUpdate = false) => {
    const c = await getYieldCycle(tx, cycleId, forUpdate);
    if (!c) throw notFound("yield cycle");
    if (!c.simulation) throw new HttpError(409, "real_gate", "non-simulation cycles are refused until the real gates of the plan (§2.1) are approved");
    return c;
  };
  const move = (permission: Permission, to: YieldTransitionRequest["to"], schema: z.ZodTypeAny = reasonSchema) => async (req: FastifyRequest) => {
    const { cycleId } = parse(cycleParams, req.params);
    const body = parse(schema, req.body ?? {}) as { reason?: string };
    return run(req, permission, async (tx, userId) => {
      await simulationCycle(tx, cycleId, true);
      const r = await transitionYieldCycle(tx, cycleId, { to, actorUserId: userId, reason: body.reason });
      return toYieldCycle(r.cycle);
    });
  };

  /** Loads what `calculate` and `preview` hand to the engine, refusing (no change) anything not calculable. */
  const calculationRequest = async (tx: TenantTx, cycleId: string): Promise<YieldCalculationRequest> => {
    const cycle = await simulationCycle(tx, cycleId, true);
    if (cycle.status !== "inputs_locked") throw new HttpError(409, "invalid_transition", `calculate needs an inputs_locked cycle (it is ${cycle.status})`);
    if (cycle.slotStart === null || cycle.slotEnd === null) throw new HttpError(422, "calculation_incomplete", "set the slot range first");
    const asset = { network: cycle.network, rail: cycle.rail, id: cycle.chainAssetId } as ChainAssetRef;
    const ownership = await loadWeightedOwnershipInput(app.deps.pool, tx.tenantId, { asset, window: { startSlot: cycle.slotStart, endSlot: cycle.slotEnd }, simulation: cycle.simulation });
    const stored = await latestSimulationDossier(tx, cycleId);
    // A stored dossier was checked when registered; parsed again here, so a bad row still fails closed.
    const dossier = stored ? parseSimulationDossier(stored.body) : null;
    // The carry-in is the predecessor's recorded carry-out (0028), checked against its hash; else the empty ledger.
    const carry = await yieldCarryIn(tx, cycleId);
    const carryIn = carry.ledger
      ? { sourceSetId: carry.sourceSetId, ledger: await parseCarryLedger(carry.ledger.body, carry.ledger.sha256), sha256: carry.ledger.sha256 }
      : { sourceSetId: null, ledger: EMPTY_CARRY_LEDGER, sha256: await carryLedgerHash(EMPTY_CARRY_LEDGER) };
    return { cycle, inputs: await listYieldInputs(tx, cycleId), ownership, dossier, evidenceSha256ByInput: await yieldInputEvidenceHashes(tx, cycleId), carryIn };
  };
  const engine = () => {
    if (!app.deps.yieldEngine) throw new HttpError(503, "calculation_engine_unavailable", "no yield calculation engine is configured on this line (integration with the yield domain is pending)");
    return app.deps.yieldEngine;
  };
  const runEngine = async (request: YieldCalculationRequest): Promise<YieldCalculationResult> => {
    const out = await engine().calculate(request);
    const problems = engineOutputProblems(request, out);
    if (problems.length) throw new HttpError(502, "engine_output_invalid", "the calculation engine returned allocations that do not match the ownership input", problems);
    return out;
  };

  app.post("/v1/tenants/:tenantId/yield/cycles", async (req, reply) => {
    parse(tenantParams, req.params);
    enabled();
    const b = parse(createCycleSchema, req.body);
    const out = await run(req, "yield:prepare", async (tx, userId) => {
      if (!b.simulation) throw new HttpError(409, "real_gate", "only simulation cycles can be created until the real gates of the plan (§2.1) are approved");
      return toYieldCycle(await createYieldCycle(tx, { ...b, simulation: true, createdBy: userId }));
    });
    return reply.status(201).send(out);
  });

  app.patch("/v1/tenants/:tenantId/yield/cycles/:cycleId", async (req) => {
    const { cycleId } = parse(cycleParams, req.params);
    const b = parse(parametersSchema, req.body);
    return run(req, "yield:prepare", async (tx, userId) => {
      await simulationCycle(tx, cycleId, true);
      const { slotStart, slotEnd, ...rest } = b;
      const c = await setYieldCycleParameters(tx, cycleId, { ...rest, ...(slotStart ? { slotStart: BigInt(slotStart) } : {}), ...(slotEnd ? { slotEnd: BigInt(slotEnd) } : {}) }, userId);
      return toYieldCycle(c);
    });
  });

  app.post("/v1/tenants/:tenantId/yield/evidence", async (req, reply) => {
    parse(tenantParams, req.params);
    const b = parse(evidenceSchema, req.body);
    const id = await run(req, "yield:prepare", (tx, userId) => registerYieldEvidence(tx, { ...b, simulation: true, createdBy: userId }));
    return reply.status(201).send({ id, simulation: true });
  });

  app.post("/v1/tenants/:tenantId/yield/cycles/:cycleId/inputs", async (req, reply) => {
    const { cycleId } = parse(cycleParams, req.params);
    const b = parse(inputSchema, req.body);
    const id = await run(req, "yield:prepare", async (tx, userId) => {
      await simulationCycle(tx, cycleId, true);
      return addYieldInput(tx, cycleId, { ...b, amount: BigInt(b.amount), createdBy: userId });
    });
    return reply.status(201).send({ id });
  });

  app.post("/v1/tenants/:tenantId/yield/cycles/:cycleId/lock", move("yield:prepare", "inputs_locked"));
  app.post("/v1/tenants/:tenantId/yield/cycles/:cycleId/unlock", async (req) => {
    const { cycleId } = parse(cycleParams, req.params);
    const body = parse(reasonSchema, req.body ?? {});
    return run(req, "yield:prepare", async (tx, userId) => {
      const c = await simulationCycle(tx, cycleId, true);
      const to = c.status === "inputs_locked" ? "draft" : "inputs_locked";
      return toYieldCycle((await transitionYieldCycle(tx, cycleId, { to, actorUserId: userId, reason: body.reason })).cycle);
    });
  });
  app.post("/v1/tenants/:tenantId/yield/cycles/:cycleId/submit", move("yield:prepare", "under_review"));
  app.post("/v1/tenants/:tenantId/yield/cycles/:cycleId/reject", move("yield:review", "inputs_locked", cancelSchema));
  app.post("/v1/tenants/:tenantId/yield/cycles/:cycleId/publish", move("yield:approve", "published"));
  app.post("/v1/tenants/:tenantId/yield/cycles/:cycleId/cancel", move("yield:approve", "cancelled", cancelSchema));

  /**
   * Registers the cycle's simulation dossier (simulation draft cycles only; a new revision each time; the latest at
   * lock is the one calculated with). Stored as canonical text with its SHA-256.
   */
  app.post("/v1/tenants/:tenantId/yield/cycles/:cycleId/simulation-dossier", async (req, reply) => {
    const { cycleId } = parse(cycleParams, req.params);
    const out = await run(req, "yield:prepare", async (tx, userId) => {
      await simulationCycle(tx, cycleId, true);
      const dossier = parseSimulationDossier(req.body);
      const body = canonicalSimulationDossier(dossier);
      const sha256 = await simulationDossierHash(dossier);
      return registerSimulationDossier(tx, cycleId, { body, sha256, createdBy: userId });
    });
    return reply.status(201).send(out);
  });

  /** Non-mutating calculation: the engine's numbers for the cycle as it stands. Stores nothing (plan §2.1). */
  app.post("/v1/tenants/:tenantId/yield/cycles/:cycleId/preview", async (req) => {
    const { cycleId } = parse(cycleParams, req.params);
    return run(req, "yield:prepare", async (tx) => {
      const request = await calculationRequest(tx, cycleId);
      const out = await runEngine(request);
      return {
        preview: true,
        ownership: { commitment: request.ownership.commitment, sourceKind: request.ownership.provenance.sourceKind, totalWeight: request.ownership.totalWeight.toString() },
        hashes: { calculation: out.calculationHash, allocation: out.allocationHash, evidenceBundle: out.evidenceBundleHash, merkleRoot: out.merkleRoot, set: out.setHash },
        totals: out.totals,
        allocations: out.allocations.map((a) => ({ kind: a.kind, partyId: a.partyId ?? null, holderKey: a.holderKey ?? null, weight: a.weight.toString(), amount: a.amount.toString() })),
      };
    });
  });

  /** Authoritative calculation: freezes the artifact set (D-11: the freeze point is `calculate`). */
  app.post("/v1/tenants/:tenantId/yield/cycles/:cycleId/calculate", async (req) => {
    const { cycleId } = parse(cycleParams, req.params);
    return run(req, "yield:prepare", async (tx, userId) => {
      const request = await calculationRequest(tx, cycleId);
      const out = await runEngine(request);
      const o = request.ownership;
      const r = await recordCalculation(tx, cycleId, {
        calculationHash: out.calculationHash,
        allocationHash: out.allocationHash,
        evidenceBundleHash: out.evidenceBundleHash,
        merkleRoot: out.merkleRoot,
        setHash: out.setHash,
        snapshot: { sourceKind: o.provenance.sourceKind, sourceIdentityId: o.provenance.sourceIdentity?.id ?? null, cursorSlot: o.provenance.cursorSlot, holdingModel: "slot_weighted", inputCommitment: o.commitment, totalWeight: o.totalWeight },
        allocations: out.allocations,
        frozen: out.frozen,
        carry: { sourceSetId: request.carryIn.sourceSetId, ledgerIn: out.carry.ledgerIn, ledgerOut: out.carry.ledgerOut },
        actorUserId: userId,
      });
      return { ...(await yieldCycleDetail(tx, cycleId)), artifactSetId: r.artifactSetId };
    });
  });

  app.post("/v1/tenants/:tenantId/yield/cycles/:cycleId/attestations", async (req, reply) => {
    const { cycleId } = parse(cycleParams, req.params);
    const b = parse(attestSchema, req.body);
    const id = await run(req, "yield:attest", async (tx, userId) => {
      await simulationCycle(tx, cycleId);
      if (!(await listYieldArtifactSets(tx, cycleId)).some((s) => s.id === b.artifactSetId)) throw notFound("artifact set");
      return addYieldAttestation(tx, { artifactSetId: b.artifactSetId, attesterUserId: userId, kind: b.kind, attestedHash: b.attestedHash, statement: b.statement });
    });
    return reply.status(201).send({ id });
  });

  /** Four-eyes approval (the database refuses the cycle's creator or preparer) after the simulation quorum. */
  app.post("/v1/tenants/:tenantId/yield/cycles/:cycleId/approve", async (req) => {
    const { cycleId } = parse(cycleParams, req.params);
    const body = parse(reasonSchema, req.body ?? {});
    return run(req, "yield:approve", async (tx, userId) => {
      const c = await simulationCycle(tx, cycleId, true);
      const live = (await listYieldArtifactSets(tx, cycleId)).find((s) => s.status === "frozen" && s.setHash === c.artifactSetHash);
      const attesters = live ? await activeYieldAttesters(tx, live.id) : [];
      if (attesters.length < SIMULATION_ATTESTATION_QUORUM)
        throw new HttpError(409, "quorum_not_met", `approval needs ${SIMULATION_ATTESTATION_QUORUM} attestation(s) of the artifact set; it has ${attesters.length}`);
      return toYieldCycle((await transitionYieldCycle(tx, cycleId, { to: "approved", actorUserId: userId, reason: body.reason })).cycle);
    });
  });

  app.post("/v1/tenants/:tenantId/yield/cycles/:cycleId/close", async (req) => {
    const { cycleId } = parse(cycleParams, req.params);
    const b = parse(closeSchema, req.body);
    return run(req, "yield:approve", async (tx, userId) => {
      await simulationCycle(tx, cycleId, true);
      return toYieldCycle((await transitionYieldCycle(tx, cycleId, { to: "closed", actorUserId: userId, closeReason: b.reason, reason: b.note })).cycle);
    });
  });
}
