/** What the execution engine reads and writes: intents to drive and the chain operations that carry them. */
import type { IntentStatus, Network, OperationState } from "@metafarm/domain";
import type { SystemTx, TenantTx } from "../tenant";

export type IntentType = "issuance" | "settlement";

/** Subscriptions whose payment is verified, waiting for their shares. */
export async function ordersAwaitingIssuance(tx: SystemTx, limit = 500): Promise<{ tenant_id: string; id: string }[]> {
  return (
    await tx.query<{ tenant_id: string; id: string }>(`SELECT tenant_id, id FROM rwa_orders WHERE kind = 'subscription' AND status = 'issuing' ORDER BY updated_at LIMIT $1`, [limit])
  ).rows;
}

export async function createIssuanceIntent(
  tx: TenantTx,
  i: { representationId: string; action: "mint" | "burn" | "freeze" | "thaw"; amount: bigint | null; holder: string; reconciliationId: string; partyId: string; decision: object },
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO issuance_intents (tenant_id, representation_id, action, amount, holder_address, reconciliation_id, idempotency_key, status, policy_decision, party_id)
     VALUES ($1, $2, $3, $4::numeric, $5, $6, gen_random_uuid(), 'approved', $7::jsonb, $8) RETURNING id`,
    [tx.tenantId, i.representationId, i.action, i.amount?.toString() ?? null, i.holder, i.reconciliationId, JSON.stringify(i.decision), i.partyId],
  );
  return r.rows[0]!.id;
}

/** Intents that still need chain work, across workspaces. */
export async function intentsToDrive(tx: SystemTx, limit = 500): Promise<{ tenant_id: string; type: IntentType; id: string }[]> {
  return (
    await tx.query<{ tenant_id: string; type: IntentType; id: string }>(
      `SELECT tenant_id, 'issuance'::text AS type, id FROM issuance_intents WHERE status IN ('approved', 'in_progress')
       UNION ALL
       SELECT tenant_id, 'settlement', id FROM settlement_intents WHERE direction = 'outbound' AND status IN ('approved', 'in_progress')
       LIMIT $1`,
      [limit],
    )
  ).rows;
}

export async function setIntentStatus(tx: TenantTx, type: IntentType, id: string, status: IntentStatus): Promise<void> {
  const table = type === "issuance" ? "issuance_intents" : "settlement_intents";
  await tx.query(`UPDATE ${table} SET status = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id, status]);
}

export interface OperationRow {
  id: string;
  intent_type: IntentType;
  intent_id: string;
  attempt: number;
  network: Network;
  state: OperationState;
  tx_ref: string | null;
  signed_wire: string | null;
  last_valid_block_height: string | null;
  expires_at: Date | null;
  error: string | null;
}

const OP_SELECT = `SELECT id, intent_type, intent_id, attempt, network, state, tx_ref, signed_wire, last_valid_block_height::text, expires_at, error FROM chain_operations`;

export async function latestOperation(tx: TenantTx, type: IntentType, intentId: string): Promise<OperationRow | undefined> {
  return (await tx.query<OperationRow>(`${OP_SELECT} WHERE tenant_id = $1 AND intent_type = $2 AND intent_id = $3 ORDER BY attempt DESC LIMIT 1`, [tx.tenantId, type, intentId])).rows[0];
}

export async function getOperation(tx: TenantTx, id: string, forUpdate = false): Promise<OperationRow | undefined> {
  if (forUpdate) await tx.query(`SELECT 1 FROM chain_operations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tx.tenantId, id]);
  return (await tx.query<OperationRow>(`${OP_SELECT} WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id])).rows[0];
}

export async function createOperation(tx: TenantTx, type: IntentType, intentId: string, attempt: number, network: Network): Promise<string> {
  return (
    await tx.query<{ id: string }>(`INSERT INTO chain_operations (tenant_id, intent_type, intent_id, attempt, network) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
      tx.tenantId,
      type,
      intentId,
      attempt,
      network,
    ])
  ).rows[0]!.id;
}

/** Operations not yet finished, across workspaces. */
export async function operationsToDrive(tx: SystemTx, limit = 500): Promise<{ tenant_id: string; id: string }[]> {
  return (
    await tx.query<{ tenant_id: string; id: string }>(
      `SELECT tenant_id, id FROM chain_operations WHERE state IN ('requested', 'policy_approved', 'prepared', 'submitted', 'observed', 'confirmed') ORDER BY updated_at LIMIT $1`,
      [limit],
    )
  ).rows;
}

/** Moves an operation to a new state (the database checks the transition) and records what came with it. */
export async function moveOperation(
  tx: TenantTx,
  id: string,
  state: OperationState,
  f: {
    txRef?: string;
    signedWire?: string;
    lastValidBlockHeight?: bigint;
    expiresAt?: Date;
    priorityFee?: bigint;
    feeLimitSun?: bigint;
    estimatedEnergy?: bigint;
    estimatedBandwidth?: bigint;
    slotOrBlock?: bigint;
    confirmations?: number;
    feePaid?: bigint;
    error?: string;
    summary?: object;
  } = {},
): Promise<void> {
  await tx.query(
    `UPDATE chain_operations SET state = $2,
        tx_ref = coalesce($3, tx_ref), signed_wire = coalesce($4, signed_wire),
        last_valid_block_height = coalesce($5::bigint, last_valid_block_height), expires_at = coalesce($6, expires_at),
        priority_fee_micro_lamports = coalesce($7::bigint, priority_fee_micro_lamports), fee_limit_sun = coalesce($8::bigint, fee_limit_sun),
        estimated_energy = coalesce($9::bigint, estimated_energy), estimated_bandwidth = coalesce($10::bigint, estimated_bandwidth),
        observed_slot_or_block = coalesce($11::bigint, observed_slot_or_block), confirmations = coalesce($12, confirmations),
        fee_paid = coalesce($13::numeric, fee_paid), error = coalesce($14, error), prepared_summary = coalesce($15::jsonb, prepared_summary)
      WHERE tenant_id = $1 AND id = $16`,
    [
      tx.tenantId,
      state,
      f.txRef ?? null,
      f.signedWire ?? null,
      f.lastValidBlockHeight?.toString() ?? null,
      f.expiresAt ?? null,
      f.priorityFee?.toString() ?? null,
      f.feeLimitSun?.toString() ?? null,
      f.estimatedEnergy?.toString() ?? null,
      f.estimatedBandwidth?.toString() ?? null,
      f.slotOrBlock?.toString() ?? null,
      f.confirmations ?? null,
      f.feePaid?.toString() ?? null,
      f.error ?? null,
      f.summary ? JSON.stringify(f.summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : null,
      id,
    ],
  );
}

/** Everything needed to carry out an issuance intent. */
export async function issuanceContext(tx: TenantTx, intentId: string) {
  return (
    await tx.query<{
      id: string;
      action: "mint" | "burn" | "freeze" | "thaw";
      amount: string | null;
      holder_address: string;
      status: IntentStatus;
      party_id: string | null;
      network: Network;
      mint_address: string | null;
      decimals: number | null;
    }>(
      `SELECT i.id, i.action, i.amount::text, i.holder_address, i.status, i.party_id, r.network, r.mint_address, r.decimals
         FROM issuance_intents i JOIN asset_representations r ON r.tenant_id = i.tenant_id AND r.id = i.representation_id
        WHERE i.tenant_id = $1 AND i.id = $2`,
      [tx.tenantId, intentId],
    )
  ).rows[0];
}

// ── Assets and share tokens (API) ──────────────────────────────────────

export async function createBusinessAsset(
  tx: TenantTx,
  a: { farmId: string; kind: string; name: string; externalRef?: string | null; geometry?: object | null; geomProvenance?: string | null; parcelLabel?: string | null; createdBy: string },
): Promise<string> {
  return (
    await tx.query<{ id: string }>(
      `INSERT INTO business_assets (tenant_id, farm_id, kind, name, external_ref, geom, geom_provenance, parcel_label, created_by)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::text IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($6::text), 4326) END, $7, $8, $9) RETURNING id`,
      [tx.tenantId, a.farmId, a.kind, a.name, a.externalRef ?? null, a.geometry ? JSON.stringify(a.geometry) : null, a.geomProvenance ?? null, a.parcelLabel ?? null, a.createdBy],
    )
  ).rows[0]!.id;
}

export async function verifyBusinessAsset(tx: TenantTx, id: string, userId: string): Promise<void> {
  await tx.query(`UPDATE business_assets SET status = 'verified', verified_at = now(), verified_by = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [
    tx.tenantId,
    id,
    userId,
  ]);
}

export interface BusinessAssetRow {
  id: string;
  farm_id: string;
  farm_name: string;
  kind: string;
  name: string;
  external_ref: string | null;
  parcel_label: string | null;
  geometry: object | null;
  geom_provenance: string | null;
  status: string;
  verified_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

const ASSET_SELECT = `
  SELECT a.id, a.farm_id, f.name AS farm_name, a.kind, a.name, a.external_ref, a.parcel_label,
         CASE WHEN a.geom IS NULL THEN NULL ELSE ST_AsGeoJSON(a.geom)::json END AS geometry, a.geom_provenance,
         a.status, a.verified_at, a.created_by, a.created_at
    FROM business_assets a JOIN farms f ON f.tenant_id = a.tenant_id AND f.id = a.farm_id`;

export async function listBusinessAssets(tx: TenantTx): Promise<BusinessAssetRow[]> {
  return (await tx.query<BusinessAssetRow>(`${ASSET_SELECT} WHERE a.tenant_id = $1 ORDER BY a.created_at DESC`, [tx.tenantId])).rows;
}

export async function getBusinessAsset(tx: TenantTx, id: string): Promise<BusinessAssetRow | undefined> {
  return (await tx.query<BusinessAssetRow>(`${ASSET_SELECT} WHERE a.tenant_id = $1 AND a.id = $2`, [tx.tenantId, id])).rows[0];
}

export interface RepresentationRow {
  id: string;
  asset_id: string;
  rail: string;
  network: Network;
  status: string;
  mint_address: string | null;
  decimals: number | null;
  created_at: Date;
}

const REP_SELECT = `SELECT id, asset_id, rail, network, status, mint_address, decimals, created_at FROM asset_representations`;

export async function listRepresentations(tx: TenantTx, assetId: string): Promise<RepresentationRow[]> {
  return (await tx.query<RepresentationRow>(`${REP_SELECT} WHERE tenant_id = $1 AND asset_id = $2 ORDER BY created_at`, [tx.tenantId, assetId])).rows;
}

export async function getRepresentation(tx: TenantTx, id: string): Promise<RepresentationRow | undefined> {
  return (await tx.query<RepresentationRow>(`${REP_SELECT} WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id])).rows[0];
}

export async function createRepresentation(tx: TenantTx, assetId: string, network: Network, decimals: number): Promise<string> {
  return (
    await tx.query<{ id: string }>(
      `INSERT INTO asset_representations (tenant_id, asset_id, rail, network, decimals) VALUES ($1, $2, 'SOLANA_TOKEN_2022', $3, $4) RETURNING id`,
      [tx.tenantId, assetId, network, decimals],
    )
  ).rows[0]!.id;
}

export async function linkMint(tx: TenantTx, id: string, mintAddress: string, decimals: number): Promise<void> {
  await tx.query(`UPDATE asset_representations SET mint_address = $3, decimals = $4, status = 'active', updated_at = now() WHERE tenant_id = $1 AND id = $2`, [
    tx.tenantId,
    id,
    mintAddress,
    decimals,
  ]);
}

// ── Payouts and approvals ──────────────────────────────────────────────

/** Orders whose next leg the engine may start (approved redemptions and distributions, paid subscriptions). */
export async function ordersToAdvance(tx: SystemTx, limit = 500): Promise<{ tenant_id: string; id: string }[]> {
  return (
    await tx.query<{ tenant_id: string; id: string }>(`SELECT tenant_id, id FROM rwa_orders WHERE status IN ('issuing', 'settling') ORDER BY updated_at LIMIT $1`, [limit])
  ).rows;
}

export async function createSettlementIntent(
  tx: TenantTx,
  i: {
    network: Network;
    tokenContract: string;
    purpose: "redemption" | "distribution" | "refund";
    payer: string;
    payee: string;
    amount: bigint;
    reconciliationId: string;
    partyId: string;
    decision: object;
  },
): Promise<string> {
  return (
    await tx.query<{ id: string }>(
      `INSERT INTO settlement_intents (tenant_id, network, token_contract, purpose, payer_address, payee_address, amount, reconciliation_id, idempotency_key,
                                       status, policy_decision, party_id, direction)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, gen_random_uuid(), 'approved', $9::jsonb, $10, 'outbound') RETURNING id`,
      [tx.tenantId, i.network, i.tokenContract, i.purpose, i.payer, i.payee, i.amount.toString(), i.reconciliationId, JSON.stringify(i.decision), i.partyId],
    )
  ).rows[0]!.id;
}

/** Everything needed to carry out an outbound settlement intent. */
export async function settlementContext(tx: TenantTx, intentId: string) {
  return (
    await tx.query<{ id: string; network: Network; token_contract: string; purpose: string; payer_address: string; payee_address: string; amount: string; party_id: string | null }>(
      `SELECT id, network, token_contract, purpose, payer_address, payee_address, amount::text, party_id FROM settlement_intents
        WHERE tenant_id = $1 AND id = $2 AND direction = 'outbound'`,
      [tx.tenantId, intentId],
    )
  ).rows[0];
}

export async function approveOrder(tx: TenantTx, orderId: string, userId: string, nextStatus: "issuing" | "settling"): Promise<void> {
  await tx.query(`UPDATE rwa_orders SET approved_by = $3, approved_at = now(), status = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [
    tx.tenantId,
    orderId,
    userId,
    nextStatus,
  ]);
}

export async function orderCreator(tx: TenantTx, orderId: string): Promise<{ created_by: string | null; approved_by: string | null } | undefined> {
  return (await tx.query<{ created_by: string | null; approved_by: string | null }>(`SELECT created_by, approved_by FROM rwa_orders WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, orderId])).rows[0];
}
