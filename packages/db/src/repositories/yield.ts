/**
 * Y7: typed access to the yield schema (migration 0024). The database enforces the state machine, frozen columns,
 * four-eyes, append-only history and the D-17 fixture exclusion; this module turns its refusals into a
 * YieldStoreError with a stable code and writes who-did-what to audit_events (D-31: reuse audit_events; state
 * history stays in yield_cycle_transitions).
 *
 * Nothing here calculates: `recordCalculation` stores an artifact set computed elsewhere (the yield domain,
 * on the yield line) and moves the cycle to `calculated` in the caller's transaction. Nothing signs, submits or
 * contacts a chain.
 */
import type { TenantTx } from "../tenant";
import { writeAudit } from "./ops";
import { type PageRequest, assertCursor } from "./page";

export const YIELD_STORE_ERROR_CODES = [
  "not_found",
  "forbidden",
  "duplicate",
  "invalid_input",
  "invalid_create",
  "invalid_transition",
  "actor_required",
  "frozen",
  "immutable",
  "lock_incomplete",
  "calculation_incomplete",
  "not_calculating",
  "four_eyes",
  "artifact_set_changed",
  "future_phase",
  "real_gate",
  "fixture_in_real_cycle",
  "simulation_record_in_real_cycle",
  "unverified_source",
  "snapshot_mismatch",
  "attestation_mismatch",
  "cycle_not_draft",
  "double_counted",
  "evidence_retention_unapproved",
  "refused",
] as const;
export type YieldStoreErrorCode = (typeof YIELD_STORE_ERROR_CODES)[number];

export class YieldStoreError extends Error {
  constructor(
    readonly code: YieldStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "YieldStoreError";
  }
}

const CONSTRAINT_CODES: Record<string, YieldStoreErrorCode> = {
  yield_cycles_real_gate: "real_gate",
  yield_cycles_no_future_phase: "future_phase",
  yield_evidence_simulation_only: "evidence_retention_unapproved",
  yield_ownership_snapshots_source_identity: "unverified_source",
  yield_ownership_snapshots_source_identity_id_network_fkey: "unverified_source",
};

/** Maps a PostgreSQL error from the yield schema to a stable code; anything else is rethrown unchanged. */
export function toYieldStoreError(err: unknown): unknown {
  const e = err as { code?: string; hint?: string; constraint?: string; message?: string };
  if (typeof e?.code !== "string") return err;
  const message = e.message ?? "refused";
  if (e.hint?.startsWith("yield:")) {
    const c = e.hint.slice(6) as YieldStoreErrorCode;
    if ((YIELD_STORE_ERROR_CODES as readonly string[]).includes(c)) return new YieldStoreError(c, message);
  }
  if (e.constraint && CONSTRAINT_CODES[e.constraint]) return new YieldStoreError(CONSTRAINT_CODES[e.constraint]!, message);
  switch (e.code) {
    case "23505":
      return new YieldStoreError("duplicate", message);
    case "23503":
      return new YieldStoreError("not_found", message);
    case "23514":
    case "22P02":
    case "22003":
    case "22001":
      return new YieldStoreError("invalid_input", message);
    case "42501":
      return new YieldStoreError("forbidden", message);
    default:
      return err;
  }
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toYieldStoreError(err);
  }
}

/** Runs `fn` under a savepoint, so a refusal leaves the caller's transaction usable (and changes nothing). */
async function atomically<T>(tx: TenantTx, fn: () => Promise<T>): Promise<T> {
  await tx.query("SAVEPOINT yield_op");
  try {
    const r = await fn();
    await tx.query("RELEASE SAVEPOINT yield_op");
    return r;
  } catch (err) {
    await tx.query("ROLLBACK TO SAVEPOINT yield_op");
    throw toYieldStoreError(err);
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const hash = (name: string, v: string) => {
  if (!HEX64.test(v)) throw new YieldStoreError("invalid_input", `${name} must be lowercase SHA-256 hex`);
  return v;
};

// ── Cycles ─────────────────────────────────────────────────────────────

export type YieldCycleStatus =
  | "draft"
  | "inputs_locked"
  | "calculated"
  | "under_review"
  | "approved"
  | "published"
  | "funded"
  | "distributing"
  | "disputed"
  | "closed"
  | "cancelled"
  | "abandoned"
  | "superseded";

export interface YieldCycleRow {
  id: string;
  businessAssetId: string;
  periodStart: string;
  periodEnd: string;
  version: number;
  simulation: boolean;
  status: YieldCycleStatus;
  priorStatus: string | null;
  closeReason: string | null;
  network: string;
  rail: string;
  chainAssetId: string;
  entitlementRef: string | null;
  policyHash: string | null;
  formulaVersion: string | null;
  accountingCurrency: string | null;
  settlementMint: string | null;
  settlementDecimals: number | null;
  slotStart: bigint | null;
  slotEnd: bigint | null;
  artifactSetHash: string | null;
  merkleRoot: string | null;
  preparedBy: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const CYCLE_SELECT = `SELECT id, business_asset_id, period_start::text, period_end::text, version, simulation, status, prior_status, close_reason,
  network, rail, chain_asset_id, entitlement_ref, policy_hash, formula_version, accounting_currency, settlement_mint, settlement_decimals,
  slot_start::text, slot_end::text, artifact_set_hash, merkle_root, prepared_by, created_by, created_at, updated_at FROM yield_cycles`;

type CycleDbRow = {
  id: string;
  business_asset_id: string;
  period_start: string;
  period_end: string;
  version: number;
  simulation: boolean;
  status: YieldCycleStatus;
  prior_status: string | null;
  close_reason: string | null;
  network: string;
  rail: string;
  chain_asset_id: string;
  entitlement_ref: string | null;
  policy_hash: string | null;
  formula_version: string | null;
  accounting_currency: string | null;
  settlement_mint: string | null;
  settlement_decimals: number | null;
  slot_start: string | null;
  slot_end: string | null;
  artifact_set_hash: string | null;
  merkle_root: string | null;
  prepared_by: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

const toCycle = (r: CycleDbRow): YieldCycleRow => ({
  id: r.id,
  businessAssetId: r.business_asset_id,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  version: r.version,
  simulation: r.simulation,
  status: r.status,
  priorStatus: r.prior_status,
  closeReason: r.close_reason,
  network: r.network,
  rail: r.rail,
  chainAssetId: r.chain_asset_id,
  entitlementRef: r.entitlement_ref,
  policyHash: r.policy_hash,
  formulaVersion: r.formula_version,
  accountingCurrency: r.accounting_currency,
  settlementMint: r.settlement_mint,
  settlementDecimals: r.settlement_decimals,
  slotStart: r.slot_start === null ? null : BigInt(r.slot_start),
  slotEnd: r.slot_end === null ? null : BigInt(r.slot_end),
  artifactSetHash: r.artifact_set_hash,
  merkleRoot: r.merkle_root,
  preparedBy: r.prepared_by,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface NewYieldCycle {
  businessAssetId: string;
  periodStart: string;
  periodEnd: string;
  version?: number;
  /** Defaults to true: a real cycle is asked for explicitly (plan §12.1). */
  simulation?: boolean;
  network: "solana-devnet" | "solana-mainnet";
  rail: "SOLANA_TOKEN_2022" | "SOLANA_BUBBLEGUM_CNFT";
  chainAssetId: string;
  createdBy: string;
}

export async function createYieldCycle(tx: TenantTx, c: NewYieldCycle): Promise<YieldCycleRow> {
  const row = await atomically(tx, async () => {
    const r = await tx.query<CycleDbRow>(
      `INSERT INTO yield_cycles (tenant_id, business_asset_id, period_start, period_end, version, simulation, network, rail, chain_asset_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [tx.tenantId, c.businessAssetId, c.periodStart, c.periodEnd, c.version ?? 1, c.simulation ?? true, c.network, c.rail, c.chainAssetId, c.createdBy],
    );
    return r.rows[0]!;
  });
  await writeAudit(tx, { actorUserId: c.createdBy, actorType: "user", action: "yield.cycle.create", targetType: "yield_cycle", targetId: row.id, metadata: { simulation: c.simulation ?? true } });
  return (await getYieldCycle(tx, row.id))!;
}

export async function getYieldCycle(tx: TenantTx, id: string, forUpdate = false): Promise<YieldCycleRow | undefined> {
  if (forUpdate) await tx.query(`SELECT 1 FROM yield_cycles WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tx.tenantId, id]);
  const r = await guarded(() => tx.query<CycleDbRow>(`${CYCLE_SELECT} WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id]));
  return r.rows[0] ? toCycle(r.rows[0]) : undefined;
}

/** Cycles, newest first; keyset paging (`limit + 1` rows, see page.ts). Optional status filter. */
export async function listYieldCycles(tx: TenantTx, page: PageRequest = { limit: 199 }, filter: { status?: YieldCycleStatus; simulation?: boolean } = {}): Promise<YieldCycleRow[]> {
  await assertCursor(tx, `SELECT 1 FROM yield_cycles WHERE tenant_id = $1 AND id = $2`, page.after);
  const r = await tx.query<CycleDbRow>(
    `${CYCLE_SELECT} WHERE tenant_id = $1
        AND ($3::uuid IS NULL OR (created_at, id) < (SELECT c.created_at, c.id FROM yield_cycles c WHERE c.tenant_id = $1 AND c.id = $3))
        AND ($4::text IS NULL OR status = $4) AND ($5::boolean IS NULL OR simulation = $5)
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [tx.tenantId, page.limit + 1, page.after ?? null, filter.status ?? null, filter.simulation ?? null],
  );
  return r.rows.map(toCycle);
}

export interface YieldCycleParameters {
  entitlementRef?: string;
  policyHash?: string;
  formulaVersion?: string;
  accountingCurrency?: string;
  settlementMint?: string;
  settlementDecimals?: number;
  slotStart?: bigint;
  slotEnd?: bigint;
}

/** Sets calculation parameters (allowed in draft; only the slot range once inputs_locked). */
export async function setYieldCycleParameters(tx: TenantTx, id: string, p: YieldCycleParameters, actorUserId: string): Promise<YieldCycleRow> {
  for (const [k, v] of [["entitlementRef", p.entitlementRef], ["policyHash", p.policyHash]] as const) if (v !== undefined) hash(k, v);
  const r = await atomically(tx, () =>
    tx.query(
      `UPDATE yield_cycles SET
         entitlement_ref = COALESCE($3, entitlement_ref), policy_hash = COALESCE($4, policy_hash), formula_version = COALESCE($5, formula_version),
         accounting_currency = COALESCE($6, accounting_currency), settlement_mint = COALESCE($7, settlement_mint),
         settlement_decimals = COALESCE($8, settlement_decimals), slot_start = COALESCE($9::bigint, slot_start), slot_end = COALESCE($10::bigint, slot_end)
       WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, id, p.entitlementRef ?? null, p.policyHash ?? null, p.formulaVersion ?? null, p.accountingCurrency ?? null, p.settlementMint ?? null, p.settlementDecimals ?? null, p.slotStart?.toString() ?? null, p.slotEnd?.toString() ?? null],
    ),
  );
  if (!r.rowCount) throw new YieldStoreError("not_found", `yield cycle ${id} not found`);
  await writeAudit(tx, { actorUserId, actorType: "user", action: "yield.cycle.parameters", targetType: "yield_cycle", targetId: id, metadata: { fields: Object.keys(p).sort() } });
  return (await getYieldCycle(tx, id))!;
}

export interface YieldTransitionRequest {
  to: YieldCycleStatus;
  /** Null only for the system's `expire`. */
  actorUserId: string | null;
  reason?: string;
  closeReason?: "no_distribution" | "loss" | "unfunded" | "simulation";
}

/**
 * Moves a cycle (every rule is the database's; refusals become YieldStoreError and change nothing). Writes the
 * audit event; the transition itself is logged by the trigger. Returns the cycle and the command recorded.
 */
export async function transitionYieldCycle(tx: TenantTx, id: string, t: YieldTransitionRequest): Promise<{ cycle: YieldCycleRow; command: string }> {
  if (t.to === "calculated") throw new YieldStoreError("invalid_transition", "calculate goes through recordCalculation");
  const command = await atomically(tx, async () => {
    const current = await getYieldCycle(tx, id, true);
    if (!current) throw new YieldStoreError("not_found", `yield cycle ${id} not found`);
    if (current.status === t.to) throw new YieldStoreError("invalid_transition", `the cycle is already ${t.to}`);
    const r = await tx.query(
      `UPDATE yield_cycles SET status = $3, status_changed_by = $4, status_reason = $5, close_reason = COALESCE($6, close_reason)
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, id, t.to, t.actorUserId, t.reason ?? null, t.closeReason ?? null],
    );
    if (!r.rowCount) throw new YieldStoreError("not_found", `yield cycle ${id} not found`);
    return lastCommand(tx, id);
  });
  await writeAudit(tx, { actorUserId: t.actorUserId, actorType: t.actorUserId ? "user" : "system", action: `yield.cycle.${command}`, targetType: "yield_cycle", targetId: id, metadata: { to: t.to, ...(t.reason ? { reason: t.reason } : {}) } });
  return { cycle: (await getYieldCycle(tx, id))!, command };
}

async function lastCommand(tx: TenantTx, id: string): Promise<string> {
  const r = await tx.query<{ command: string }>(`SELECT command FROM yield_cycle_transitions WHERE tenant_id = $1 AND cycle_id = $2 ORDER BY id DESC LIMIT 1`, [tx.tenantId, id]);
  return r.rows[0]!.command;
}

export interface YieldTransitionRow {
  id: string;
  command: string;
  fromState: string | null;
  toState: string;
  actorUserId: string | null;
  reason: string | null;
  artifactSetHash: string | null;
  at: Date;
}

export async function listYieldCycleTransitions(tx: TenantTx, cycleId: string): Promise<YieldTransitionRow[]> {
  const r = await tx.query<{ id: string; command: string; from_state: string | null; to_state: string; actor_user_id: string | null; reason: string | null; artifact_set_hash: string | null; at: Date }>(
    `SELECT id::text, command, from_state, to_state, actor_user_id, reason, artifact_set_hash, at FROM yield_cycle_transitions WHERE tenant_id = $1 AND cycle_id = $2 ORDER BY id`,
    [tx.tenantId, cycleId],
  );
  return r.rows.map((x) => ({ id: x.id, command: x.command, fromState: x.from_state, toState: x.to_state, actorUserId: x.actor_user_id, reason: x.reason, artifactSetHash: x.artifact_set_hash, at: x.at }));
}

// ── Evidence and inputs ────────────────────────────────────────────────

export interface NewYieldEvidence {
  contentSha256: string;
  evidenceType: string;
  classification: "public" | "internal" | "confidential" | "personal";
  /** Must be true until D-24 is approved (the database refuses otherwise). */
  simulation: boolean;
  supersedes?: string;
  createdBy: string;
}

export async function registerYieldEvidence(tx: TenantTx, e: NewYieldEvidence): Promise<string> {
  hash("contentSha256", e.contentSha256);
  const id = await atomically(tx, async () => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO yield_evidence (tenant_id, content_sha256, evidence_type, classification, simulation, supersedes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [tx.tenantId, e.contentSha256, e.evidenceType, e.classification, e.simulation, e.supersedes ?? null, e.createdBy],
    );
    return r.rows[0]!.id;
  });
  await writeAudit(tx, { actorUserId: e.createdBy, actorType: "user", action: "yield.evidence.register", targetType: "yield_evidence", targetId: id, metadata: { type: e.evidenceType, simulation: e.simulation } });
  return id;
}

export interface NewYieldInput {
  side: "revenue" | "expense";
  kind: string;
  /** Accounting-currency minor units. */
  amount: bigint;
  currency: string;
  completeness: "known" | "zero" | "estimated";
  evidenceId?: string;
  sourceKind: string;
  sourceRef: string;
  createdBy: string;
}

export async function addYieldInput(tx: TenantTx, cycleId: string, i: NewYieldInput): Promise<string> {
  if (i.amount < 0n) throw new YieldStoreError("invalid_input", "amounts are non-negative minor units");
  const id = await atomically(tx, async () => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO yield_inputs (tenant_id, cycle_id, side, kind, amount, currency, completeness, evidence_id, source_kind, source_ref, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id::text`,
      [tx.tenantId, cycleId, i.side, i.kind, i.amount.toString(), i.currency, i.completeness, i.evidenceId ?? null, i.sourceKind, i.sourceRef, i.createdBy],
    );
    return r.rows[0]!.id;
  });
  await writeAudit(tx, { actorUserId: i.createdBy, actorType: "user", action: "yield.input.add", targetType: "yield_cycle", targetId: cycleId, metadata: { input: id, side: i.side, kind: i.kind } });
  return id;
}

export interface YieldInputRow {
  id: string;
  side: "revenue" | "expense";
  kind: string;
  amount: bigint;
  currency: string;
  completeness: string;
  evidenceId: string | null;
  sourceKind: string;
  sourceRef: string;
}

export async function listYieldInputs(tx: TenantTx, cycleId: string): Promise<YieldInputRow[]> {
  const r = await tx.query<{ id: string; side: "revenue" | "expense"; kind: string; amount: string; currency: string; completeness: string; evidence_id: string | null; source_kind: string; source_ref: string }>(
    `SELECT id::text, side, kind, amount::text, currency, completeness, evidence_id, source_kind, source_ref FROM yield_inputs WHERE tenant_id = $1 AND cycle_id = $2 ORDER BY id`,
    [tx.tenantId, cycleId],
  );
  return r.rows.map((x) => ({ id: x.id, side: x.side, kind: x.kind, amount: BigInt(x.amount), currency: x.currency, completeness: x.completeness, evidenceId: x.evidence_id, sourceKind: x.source_kind, sourceRef: x.source_ref }));
}

// ── Calculation results ────────────────────────────────────────────────

export interface YieldSnapshotRecord {
  sourceKind: "rpc" | "fixture";
  sourceIdentityId: string | null;
  cursorSlot: bigint;
  holdingModel: "slot_weighted";
  inputCommitment: string;
  totalWeight: bigint;
}

export interface YieldAllocationRecord {
  kind: "allocated" | "unattributed" | "withheld" | "dust";
  partyId?: string;
  holderKey?: string;
  weight: bigint;
  amount: bigint;
}

export interface YieldCalculationRecord {
  calculationHash: string;
  allocationHash: string;
  evidenceBundleHash: string;
  merkleRoot: string;
  setHash: string;
  snapshot: YieldSnapshotRecord;
  allocations: readonly YieldAllocationRecord[];
  actorUserId: string;
}

/**
 * The persistence half of `calculate`: stores the frozen artifact set, the ownership snapshot and the allocations,
 * and moves the cycle to `calculated`, all or nothing. The database refuses fixture ownership in a non-simulation
 * cycle (D-17), a snapshot of another asset or slot range, a second live set, an amount above u64, and a
 * non-simulation cycle past inputs_locked (real gate).
 */
export async function recordCalculation(tx: TenantTx, cycleId: string, c: YieldCalculationRecord): Promise<{ cycle: YieldCycleRow; artifactSetId: string }> {
  for (const k of ["calculationHash", "allocationHash", "evidenceBundleHash", "merkleRoot", "setHash"] as const) hash(k, c[k]);
  hash("inputCommitment", c.snapshot.inputCommitment);
  const artifactSetId = await atomically(tx, async () => {
    const cycle = await getYieldCycle(tx, cycleId, true);
    if (!cycle) throw new YieldStoreError("not_found", `yield cycle ${cycleId} not found`);
    const n = await tx.query<{ n: number }>(`SELECT COALESCE(max(set_number), 0) + 1 AS n FROM yield_artifact_sets WHERE tenant_id = $1 AND cycle_id = $2`, [tx.tenantId, cycleId]);
    const set = await tx.query<{ id: string }>(
      `INSERT INTO yield_artifact_sets (tenant_id, cycle_id, set_number, calculation_hash, allocation_hash, evidence_bundle_hash, merkle_root, set_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [tx.tenantId, cycleId, n.rows[0]!.n, c.calculationHash, c.allocationHash, c.evidenceBundleHash, c.merkleRoot, c.setHash, c.actorUserId],
    );
    const setId = set.rows[0]!.id;
    await tx.query(
      `INSERT INTO yield_ownership_snapshots (tenant_id, cycle_id, artifact_set_id, source_kind, source_identity_id, network, rail, chain_asset_id, slot_start, slot_end, cursor_slot, holding_model, input_commitment, total_weight)
       VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        tx.tenantId,
        cycleId,
        setId,
        c.snapshot.sourceKind,
        c.snapshot.sourceIdentityId,
        cycle.network,
        cycle.rail,
        cycle.chainAssetId,
        cycle.slotStart?.toString() ?? null,
        cycle.slotEnd?.toString() ?? null,
        c.snapshot.cursorSlot.toString(),
        c.snapshot.holdingModel,
        c.snapshot.inputCommitment,
        c.snapshot.totalWeight.toString(),
      ],
    );
    for (const a of c.allocations) {
      await tx.query(
        `INSERT INTO yield_allocations (tenant_id, cycle_id, artifact_set_id, kind, party_id, holder_key, weight, amount) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tx.tenantId, cycleId, setId, a.kind, a.partyId ?? null, a.holderKey ?? null, a.weight.toString(), a.amount.toString()],
      );
    }
    await tx.query(
      `UPDATE yield_cycles SET status = 'calculated', status_changed_by = $3, artifact_set_hash = $4, merkle_root = $5 WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, cycleId, c.actorUserId, c.setHash, c.merkleRoot],
    );
    return setId;
  });
  await writeAudit(tx, {
    actorUserId: c.actorUserId,
    actorType: "user",
    action: "yield.cycle.calculate",
    targetType: "yield_cycle",
    targetId: cycleId,
    metadata: { artifactSet: artifactSetId, setHash: c.setHash, sourceKind: c.snapshot.sourceKind, allocations: c.allocations.length },
  });
  return { cycle: (await getYieldCycle(tx, cycleId))!, artifactSetId };
}

export interface YieldArtifactSetRow {
  id: string;
  setNumber: number;
  status: "frozen" | "invalidated" | "approved" | "superseded";
  calculationHash: string;
  allocationHash: string;
  evidenceBundleHash: string;
  merkleRoot: string;
  setHash: string;
  createdAt: Date;
}

export async function listYieldArtifactSets(tx: TenantTx, cycleId: string): Promise<YieldArtifactSetRow[]> {
  const r = await tx.query<{ id: string; set_number: number; status: YieldArtifactSetRow["status"]; calculation_hash: string; allocation_hash: string; evidence_bundle_hash: string; merkle_root: string; set_hash: string; created_at: Date }>(
    `SELECT id, set_number, status, calculation_hash, allocation_hash, evidence_bundle_hash, merkle_root, set_hash, created_at FROM yield_artifact_sets WHERE tenant_id = $1 AND cycle_id = $2 ORDER BY set_number`,
    [tx.tenantId, cycleId],
  );
  return r.rows.map((x) => ({ id: x.id, setNumber: x.set_number, status: x.status, calculationHash: x.calculation_hash, allocationHash: x.allocation_hash, evidenceBundleHash: x.evidence_bundle_hash, merkleRoot: x.merkle_root, setHash: x.set_hash, createdAt: x.created_at }));
}

export interface YieldSnapshotRow extends YieldSnapshotRecord {
  artifactSetId: string;
  network: string;
  slotStart: bigint;
  slotEnd: bigint;
}

export async function getYieldOwnershipSnapshot(tx: TenantTx, artifactSetId: string): Promise<YieldSnapshotRow | undefined> {
  const r = await tx.query<{ artifact_set_id: string; source_kind: "rpc" | "fixture"; source_identity_id: string | null; network: string; slot_start: string; slot_end: string; cursor_slot: string; holding_model: "slot_weighted"; input_commitment: string; total_weight: string }>(
    `SELECT artifact_set_id, source_kind, source_identity_id::text, network, slot_start::text, slot_end::text, cursor_slot::text, holding_model, input_commitment, total_weight::text
       FROM yield_ownership_snapshots WHERE tenant_id = $1 AND artifact_set_id = $2`,
    [tx.tenantId, artifactSetId],
  );
  const x = r.rows[0];
  if (!x) return undefined;
  return {
    artifactSetId: x.artifact_set_id,
    sourceKind: x.source_kind,
    sourceIdentityId: x.source_identity_id,
    network: x.network,
    slotStart: BigInt(x.slot_start),
    slotEnd: BigInt(x.slot_end),
    cursorSlot: BigInt(x.cursor_slot),
    holdingModel: x.holding_model,
    inputCommitment: x.input_commitment,
    totalWeight: BigInt(x.total_weight),
  };
}

export interface YieldAllocationRow extends YieldAllocationRecord {
  id: string;
}

export async function listYieldAllocations(tx: TenantTx, artifactSetId: string): Promise<YieldAllocationRow[]> {
  const r = await tx.query<{ id: string; kind: YieldAllocationRecord["kind"]; party_id: string | null; holder_key: string | null; weight: string; amount: string }>(
    `SELECT id::text, kind, party_id, holder_key, weight::text, amount::text FROM yield_allocations WHERE tenant_id = $1 AND artifact_set_id = $2 ORDER BY id`,
    [tx.tenantId, artifactSetId],
  );
  return r.rows.map((x) => ({ id: x.id, kind: x.kind, ...(x.party_id ? { partyId: x.party_id } : {}), ...(x.holder_key ? { holderKey: x.holder_key } : {}), weight: BigInt(x.weight), amount: BigInt(x.amount) }));
}

// ── Attestations ───────────────────────────────────────────────────────

export async function addYieldAttestation(tx: TenantTx, a: { artifactSetId: string; attesterUserId: string; kind: "attest" | "revoke"; attestedHash: string; statement: string }): Promise<string> {
  hash("attestedHash", a.attestedHash);
  const id = await atomically(tx, async () => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO yield_attestations (tenant_id, artifact_set_id, attester_user_id, kind, attested_hash, statement) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
      [tx.tenantId, a.artifactSetId, a.attesterUserId, a.kind, a.attestedHash, a.statement],
    );
    return r.rows[0]!.id;
  });
  await writeAudit(tx, { actorUserId: a.attesterUserId, actorType: "user", action: `yield.attestation.${a.kind}`, targetType: "yield_artifact_set", targetId: a.artifactSetId, metadata: { hash: a.attestedHash } });
  return id;
}

/** Attesters whose latest word on the set is `attest` (a revocation cancels the attestation). */
export async function activeYieldAttesters(tx: TenantTx, artifactSetId: string): Promise<string[]> {
  const r = await tx.query<{ attester_user_id: string }>(
    `SELECT attester_user_id FROM yield_attestations WHERE tenant_id = $1 AND artifact_set_id = $2
      GROUP BY attester_user_id HAVING bool_or(kind = 'attest') AND NOT bool_or(kind = 'revoke') ORDER BY attester_user_id`,
    [tx.tenantId, artifactSetId],
  );
  return r.rows.map((x) => x.attester_user_id);
}

// ── Holder-facing reads (Y13) ──────────────────────────────────────────

export interface HolderAllocationRow {
  cycleId: string;
  periodStart: string;
  periodEnd: string;
  version: number;
  simulation: boolean;
  status: YieldCycleStatus;
  artifactSetId: string;
  setHash: string;
  merkleRoot: string;
  kind: "allocated" | "withheld";
  weight: bigint;
  amount: bigint;
  settlementMint: string | null;
  settlementDecimals: number | null;
}

/**
 * One party's allocations in published (or disputed) cycles, from their approved artifact set only. Read for the
 * party of an active account link (party-links.ts activePartyOfUser); never by wallet or login. Unattributed and
 * dust rows are never returned.
 */
export async function listPartyYieldAllocations(tx: TenantTx, partyId: string, opts: { simulationOnly: boolean }): Promise<HolderAllocationRow[]> {
  const r = await tx.query<{
    cycle_id: string;
    period_start: string;
    period_end: string;
    version: number;
    simulation: boolean;
    status: YieldCycleStatus;
    artifact_set_id: string;
    set_hash: string;
    merkle_root: string;
    kind: "allocated" | "withheld";
    weight: string;
    amount: string;
    settlement_mint: string | null;
    settlement_decimals: number | null;
  }>(
    `SELECT c.id AS cycle_id, c.period_start::text, c.period_end::text, c.version, c.simulation, c.status, s.id AS artifact_set_id, s.set_hash, s.merkle_root,
            a.kind, a.weight::text, a.amount::text, c.settlement_mint, c.settlement_decimals
       FROM yield_allocations a
       JOIN yield_artifact_sets s ON s.id = a.artifact_set_id AND s.status = 'approved'
       JOIN yield_cycles c ON c.tenant_id = a.tenant_id AND c.id = a.cycle_id AND c.status IN ('published', 'disputed')
      WHERE a.tenant_id = $1 AND a.party_id = $2 AND a.kind IN ('allocated', 'withheld') AND ($3::boolean = false OR c.simulation)
      ORDER BY c.period_end DESC, c.version DESC, c.id`,
    [tx.tenantId, partyId, opts.simulationOnly],
  );
  return r.rows.map((x) => ({
    cycleId: x.cycle_id,
    periodStart: x.period_start,
    periodEnd: x.period_end,
    version: x.version,
    simulation: x.simulation,
    status: x.status,
    artifactSetId: x.artifact_set_id,
    setHash: x.set_hash,
    merkleRoot: x.merkle_root,
    kind: x.kind,
    weight: BigInt(x.weight),
    amount: BigInt(x.amount),
    settlementMint: x.settlement_mint,
    settlementDecimals: x.settlement_decimals,
  }));
}

// ── Reconciliation (Y14) ───────────────────────────────────────────────

export interface YieldReconciliationFinding {
  code: "weights_do_not_sum" | "snapshot_missing" | "set_hash_mismatch" | "history_mismatch" | "audit_missing" | "no_live_set";
  detail: string;
}

/**
 * Checks a cycle's stored records against each other, read-only: every artifact set's allocation weights sum to its
 * snapshot's total weight; each set has its snapshot; a calculated-or-later cycle names its live set's hash and
 * root; the transition log ends in the cycle's status; and every logged step has its audit event (D-31). An empty
 * list means the records agree; it says nothing about the economics (that is the calculation library's).
 */
export async function reconcileYieldCycle(tx: TenantTx, cycleId: string): Promise<{ cycleId: string; status: YieldCycleStatus; findings: YieldReconciliationFinding[] }> {
  const cycle = await getYieldCycle(tx, cycleId);
  if (!cycle) throw new YieldStoreError("not_found", `yield cycle ${cycleId} not found`);
  const findings: YieldReconciliationFinding[] = [];
  const sets = await listYieldArtifactSets(tx, cycleId);
  for (const s of sets) {
    const snap = await getYieldOwnershipSnapshot(tx, s.id);
    if (!snap) {
      findings.push({ code: "snapshot_missing", detail: `set ${s.setNumber} has no ownership snapshot` });
      continue;
    }
    const sum = (await listYieldAllocations(tx, s.id)).filter((a) => a.kind !== "dust").reduce((acc, a) => acc + a.weight, 0n);
    if (sum !== snap.totalWeight) findings.push({ code: "weights_do_not_sum", detail: `set ${s.setNumber}: allocation weights ${sum} ≠ snapshot total ${snap.totalWeight}` });
  }
  const calculated = !["draft", "inputs_locked", "cancelled", "abandoned"].includes(cycle.status);
  if (calculated) {
    const live = sets.find((s) => (s.status === "frozen" || s.status === "approved" || (cycle.status === "superseded" && s.status === "superseded")) && s.setHash === cycle.artifactSetHash);
    if (!live) findings.push({ code: "no_live_set", detail: `no frozen or approved set has the cycle's hash ${cycle.artifactSetHash}` });
    else if (live.merkleRoot !== cycle.merkleRoot) findings.push({ code: "set_hash_mismatch", detail: `the cycle's root differs from set ${live.setNumber}'s` });
  }
  const history = await listYieldCycleTransitions(tx, cycleId);
  if (history.length === 0 || history[history.length - 1]!.toState !== cycle.status) findings.push({ code: "history_mismatch", detail: `the transition log does not end in ${cycle.status}` });
  const audit = await tx.query<{ action: string; n: number }>(
    `SELECT action, count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND target_type = 'yield_cycle' AND target_id = $2 AND action LIKE 'yield.cycle.%' GROUP BY action`,
    [tx.tenantId, cycleId],
  );
  const audited = new Map(audit.rows.map((r) => [r.action, r.n]));
  const logged = new Map<string, number>();
  for (const t of history) logged.set(t.command, (logged.get(t.command) ?? 0) + 1);
  for (const [command, n] of logged) {
    const a = audited.get(`yield.cycle.${command}`) ?? 0;
    if (a < n) findings.push({ code: "audit_missing", detail: `${n} ${command} step(s) logged, ${a} audited` });
  }
  return { cycleId, status: cycle.status, findings };
}
