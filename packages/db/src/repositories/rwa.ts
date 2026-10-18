import type { Discrepancy, IntentView, KycStatus, Network, OrderKind, OrderStatus, OrderView, PartyCompliance, PartyKind, ScreeningOutcome, WalletCompliance } from "@metafarm/domain";
import type { SystemTx, TenantTx } from "../tenant";

// ── Parties and wallets ────────────────────────────────────────────────

export async function createParty(tx: TenantTx, p: { kind: PartyKind; displayName: string; jurisdiction?: string | null; userId?: string | null; createdBy: string }): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO parties (tenant_id, kind, display_name, jurisdiction, user_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tx.tenantId, p.kind, p.displayName, p.jurisdiction ?? null, p.userId ?? null, p.createdBy],
  );
  return r.rows[0]!.id;
}

/** KYC outcome as recorded from the provider (or a compliance officer reviewing the provider's case). */
export async function setKyc(tx: TenantTx, partyId: string, k: { status: KycStatus; reference: string | null; expiresAt: Date | null; verifiedBy: string }): Promise<void> {
  await tx.query(
    `UPDATE parties SET kyc_status = $3, kyc_reference = $4, kyc_expires_at = $5,
            kyc_verified_at = CASE WHEN $3 = 'verified' THEN now() ELSE kyc_verified_at END,
            kyc_verified_by = CASE WHEN $3 = 'verified' THEN $6::uuid ELSE kyc_verified_by END, updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, partyId, k.status, k.reference, k.expiresAt, k.verifiedBy],
  );
}

export async function addWallet(tx: TenantTx, partyId: string, network: Network, address: string): Promise<string> {
  const r = await tx.query<{ id: string }>(`INSERT INTO party_wallets (tenant_id, party_id, network, address) VALUES ($1, $2, $3, $4) RETURNING id`, [
    tx.tenantId,
    partyId,
    network,
    address,
  ]);
  return r.rows[0]!.id;
}

export async function recordScreening(
  tx: TenantTx,
  s: { subject: "party"; partyId: string } | { subject: "wallet"; walletId: string },
  r: { provider: string; providerReference: string; outcome: ScreeningOutcome; reasons: string[]; checkedAt: Date; recordedBy: string | null },
): Promise<void> {
  await tx.query(
    `INSERT INTO compliance_screenings (tenant_id, subject, party_id, wallet_id, provider, provider_reference, outcome, reasons, checked_at, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [tx.tenantId, s.subject, s.subject === "party" ? s.partyId : null, s.subject === "wallet" ? s.walletId : null, r.provider, r.providerReference, r.outcome, r.reasons, r.checkedAt, r.recordedBy],
  );
}

/** What the compliance gate needs: the party's KYC and latest screening, and the latest screening of each wallet asked for. */
export async function complianceView(tx: TenantTx, partyId: string, wallets: { network: Network; address: string }[]): Promise<{ party: PartyCompliance; wallets: WalletCompliance[] } | undefined> {
  const p = await tx.query<{ kyc_status: KycStatus; kyc_expires_at: Date | null; jurisdiction: string | null; outcome: ScreeningOutcome | null; checked_at: Date | null }>(
    `SELECT p.kyc_status, p.kyc_expires_at, p.jurisdiction, s.outcome, s.checked_at
       FROM parties p
       LEFT JOIN LATERAL (SELECT outcome, checked_at FROM compliance_screenings c WHERE c.tenant_id = p.tenant_id AND c.party_id = p.id ORDER BY checked_at DESC, created_at DESC LIMIT 1) s ON true
      WHERE p.tenant_id = $1 AND p.id = $2`,
    [tx.tenantId, partyId],
  );
  const row = p.rows[0];
  if (!row) return undefined;
  const out: WalletCompliance[] = [];
  for (const w of wallets) {
    // Only the party's own wallets count; an unknown address is unscreened.
    const r = await tx.query<{ outcome: ScreeningOutcome | null; checked_at: Date | null }>(
      `SELECT s.outcome, s.checked_at FROM party_wallets w
         LEFT JOIN LATERAL (SELECT outcome, checked_at FROM compliance_screenings c WHERE c.tenant_id = w.tenant_id AND c.wallet_id = w.id ORDER BY checked_at DESC, created_at DESC LIMIT 1) s ON true
        WHERE w.tenant_id = $1 AND w.party_id = $2 AND w.network = $3 AND w.address = $4`,
      [tx.tenantId, partyId, w.network, w.address],
    );
    const s = r.rows[0];
    out.push({ ...w, screening: s?.outcome && s.checked_at ? { outcome: s.outcome, checkedAt: s.checked_at } : null });
  }
  return {
    party: {
      kycStatus: row.kyc_status,
      kycExpiresAt: row.kyc_expires_at,
      jurisdiction: row.jurisdiction,
      screening: row.outcome && row.checked_at ? { outcome: row.outcome, checkedAt: row.checked_at } : null,
    },
    wallets: out,
  };
}

// ── Orders ─────────────────────────────────────────────────────────────

export async function createOrder(
  tx: TenantTx,
  o: {
    kind: OrderKind;
    partyId: string;
    representationId: string | null;
    shareAmount: bigint | null;
    settlementNetwork: Network;
    tokenContract: string;
    settlementAmount: bigint;
    investorTronAddress?: string | null;
    investorSolanaAddress?: string | null;
    createdBy: string;
  },
): Promise<{ id: string; reconciliationId: string }> {
  const r = await tx.query<{ id: string; reconciliation_id: string }>(
    `INSERT INTO rwa_orders (tenant_id, kind, party_id, representation_id, share_amount, settlement_network, token_contract, settlement_amount, investor_tron_address, investor_solana_address, created_by)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8::numeric, $9, $10, $11) RETURNING id, reconciliation_id`,
    [
      tx.tenantId,
      o.kind,
      o.partyId,
      o.representationId,
      o.shareAmount?.toString() ?? null,
      o.settlementNetwork,
      o.tokenContract,
      o.settlementAmount.toString(),
      o.investorTronAddress ?? null,
      o.investorSolanaAddress ?? null,
      o.createdBy,
    ],
  );
  return { id: r.rows[0]!.id, reconciliationId: r.rows[0]!.reconciliation_id };
}

export async function setOrderStatus(tx: TenantTx, orderId: string, status: OrderStatus): Promise<void> {
  await tx.query(`UPDATE rwa_orders SET status = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, orderId, status]);
}

/** An order and its intents on both rails, as reconciliation sees them. */
export async function orderForReconciliation(tx: TenantTx, orderId: string): Promise<{ reconciliationId: string; status: OrderStatus; order: OrderView; intents: IntentView[] } | undefined> {
  const o = await tx.query<{ reconciliation_id: string; status: OrderStatus; kind: OrderKind; share_amount: string | null; settlement_amount: string; created_at: Date }>(
    `SELECT reconciliation_id, status, kind, share_amount::text, settlement_amount::text, created_at FROM rwa_orders WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, orderId],
  );
  const row = o.rows[0];
  if (!row) return undefined;
  const confirmed = `(SELECT count(*)::int FROM chain_operations c WHERE c.tenant_id = i.tenant_id AND c.intent_type = $3 AND c.intent_id = i.id AND c.state IN ('confirmed', 'business_completed'))`;
  const lastDone = `(SELECT max(c.updated_at) FROM chain_operations c WHERE c.tenant_id = i.tenant_id AND c.intent_type = $3 AND c.intent_id = i.id AND c.state = 'business_completed')`;
  const iss = await tx.query<{ action: IntentView["action"]; amount: string | null; status: IntentView["status"]; confirmed: number; done_at: Date | null }>(
    `SELECT i.action, i.amount::text, i.status, ${confirmed} AS confirmed, ${lastDone} AS done_at FROM issuance_intents i WHERE i.tenant_id = $1 AND i.reconciliation_id = $2`,
    [tx.tenantId, row.reconciliation_id, "issuance"],
  );
  const set = await tx.query<{ purpose: IntentView["purpose"]; amount: string; observed_amount: string | null; status: IntentView["status"]; confirmed: number; done_at: Date | null }>(
    `SELECT i.purpose, i.amount::text, i.observed_amount::text, i.status,
            CASE WHEN i.direction = 'inbound' AND i.status = 'completed' THEN 1 ELSE ${confirmed} END AS confirmed,
            coalesce(i.observed_at, ${lastDone}) AS done_at
       FROM settlement_intents i WHERE i.tenant_id = $1 AND i.reconciliation_id = $2`,
    [tx.tenantId, row.reconciliation_id, "settlement"],
  );
  const big = (s: string | null) => (s === null ? null : BigInt(s));
  return {
    reconciliationId: row.reconciliation_id,
    status: row.status,
    order: { kind: row.kind, shareAmount: big(row.share_amount), settlementAmount: BigInt(row.settlement_amount), createdAt: row.created_at },
    intents: [
      ...iss.rows.map((i) => ({ side: "issuance" as const, action: i.action, amount: big(i.amount), status: i.status, confirmedOperations: i.confirmed, ...(i.done_at ? { completedAt: i.done_at } : {}) })),
      ...set.rows.map((i) => ({
        side: "settlement" as const,
        purpose: i.purpose,
        amount: big(i.amount),
        ...(i.observed_amount !== null ? { observedAmount: BigInt(i.observed_amount) } : {}),
        status: i.status,
        confirmedOperations: i.confirmed,
        ...(i.done_at ? { completedAt: i.done_at } : {}),
      })),
    ],
  };
}

/** Records discrepancies as cases: one open case per kind; existing open cases are left as they are. Returns cases opened. */
export async function openReconciliationCases(tx: TenantTx, reconciliationId: string, found: Discrepancy[]): Promise<number> {
  let opened = 0;
  for (const d of found) {
    const r = await tx.query(
      `INSERT INTO reconciliation_cases (tenant_id, reconciliation_id, kind, expected, observed)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (tenant_id, reconciliation_id, kind) WHERE status IN ('open', 'investigating') DO NOTHING`,
      [tx.tenantId, reconciliationId, d.kind, JSON.stringify(d.expected), JSON.stringify(d.observed)],
    );
    opened += r.rowCount ?? 0;
  }
  return opened;
}

// ── Reads for the API ──────────────────────────────────────────────────

export interface PartyRow {
  id: string;
  kind: PartyKind;
  display_name: string;
  jurisdiction: string | null;
  kyc_status: KycStatus;
  kyc_reference: string | null;
  kyc_verified_at: Date | null;
  kyc_expires_at: Date | null;
  created_at: Date;
}

const PARTY_SELECT = `SELECT id, kind, display_name, jurisdiction, kyc_status, kyc_reference, kyc_verified_at, kyc_expires_at, created_at FROM parties`;

export async function listParties(tx: TenantTx): Promise<PartyRow[]> {
  return (await tx.query<PartyRow>(`${PARTY_SELECT} WHERE tenant_id = $1 ORDER BY lower(display_name)`, [tx.tenantId])).rows;
}

export async function getParty(tx: TenantTx, partyId: string): Promise<PartyRow | undefined> {
  return (await tx.query<PartyRow>(`${PARTY_SELECT} WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, partyId])).rows[0];
}

export async function listPartyWallets(tx: TenantTx, partyId: string) {
  return (
    await tx.query<{ id: string; network: Network; address: string; outcome: ScreeningOutcome | null; checked_at: Date | null }>(
      `SELECT w.id, w.network, w.address, s.outcome, s.checked_at FROM party_wallets w
         LEFT JOIN LATERAL (SELECT outcome, checked_at FROM compliance_screenings c WHERE c.tenant_id = w.tenant_id AND c.wallet_id = w.id ORDER BY checked_at DESC, created_at DESC LIMIT 1) s ON true
        WHERE w.tenant_id = $1 AND w.party_id = $2 ORDER BY w.created_at`,
      [tx.tenantId, partyId],
    )
  ).rows;
}

export async function listScreenings(tx: TenantTx, partyId: string, limit = 50) {
  return (
    await tx.query<{ id: string; subject: "party" | "wallet"; wallet_id: string | null; provider: string; provider_reference: string; outcome: ScreeningOutcome; reasons: string[]; checked_at: Date }>(
      `SELECT c.id, c.subject, c.wallet_id, c.provider, c.provider_reference, c.outcome, c.reasons, c.checked_at
         FROM compliance_screenings c
         LEFT JOIN party_wallets w ON w.tenant_id = c.tenant_id AND w.id = c.wallet_id
        WHERE c.tenant_id = $1 AND (c.party_id = $2 OR w.party_id = $2)
        ORDER BY c.checked_at DESC LIMIT $3`,
      [tx.tenantId, partyId, limit],
    )
  ).rows;
}

export async function walletOfParty(tx: TenantTx, partyId: string, walletId: string): Promise<boolean> {
  return ((await tx.query(`SELECT 1 FROM party_wallets WHERE tenant_id = $1 AND party_id = $2 AND id = $3`, [tx.tenantId, partyId, walletId])).rowCount ?? 0) > 0;
}

export interface OrderRow {
  id: string;
  reconciliation_id: string;
  kind: OrderKind;
  party_id: string;
  party_name: string;
  representation_id: string | null;
  share_amount: string | null;
  settlement_network: Network;
  token_contract: string;
  settlement_amount: string;
  investor_tron_address: string | null;
  investor_solana_address: string | null;
  status: OrderStatus;
  created_by: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const ORDER_SELECT = `
  SELECT o.id, o.reconciliation_id, o.kind, o.party_id, p.display_name AS party_name, o.representation_id, o.share_amount::text,
         o.settlement_network, o.token_contract, o.settlement_amount::text, o.investor_tron_address, o.investor_solana_address,
         o.status, o.created_by, o.approved_by, o.approved_at, o.created_at, o.updated_at
    FROM rwa_orders o JOIN parties p ON p.tenant_id = o.tenant_id AND p.id = o.party_id`;

export async function listOrders(tx: TenantTx, limit = 200): Promise<OrderRow[]> {
  return (await tx.query<OrderRow>(`${ORDER_SELECT} WHERE o.tenant_id = $1 ORDER BY o.created_at DESC LIMIT $2`, [tx.tenantId, limit])).rows;
}

export async function getOrder(tx: TenantTx, orderId: string, forUpdate = false): Promise<OrderRow | undefined> {
  if (forUpdate) await tx.query(`SELECT 1 FROM rwa_orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tx.tenantId, orderId]);
  return (await tx.query<OrderRow>(`${ORDER_SELECT} WHERE o.tenant_id = $1 AND o.id = $2`, [tx.tenantId, orderId])).rows[0];
}

export async function listOrderIntents(tx: TenantTx, reconciliationId: string) {
  const iss = await tx.query<{ id: string; action: string; amount: string | null; holder_address: string; status: string; created_at: Date }>(
    `SELECT id, action, amount::text, holder_address, status, created_at FROM issuance_intents WHERE tenant_id = $1 AND reconciliation_id = $2 ORDER BY created_at`,
    [tx.tenantId, reconciliationId],
  );
  const set = await tx.query<{
    id: string;
    purpose: string;
    direction: string;
    amount: string;
    payer_address: string;
    payee_address: string;
    status: string;
    observed_tx_ref: string | null;
    observed_amount: string | null;
    observed_block: string | null;
    observed_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, purpose, direction, amount::text, payer_address, payee_address, status, observed_tx_ref, observed_amount::text, observed_block::text, observed_at, created_at
       FROM settlement_intents WHERE tenant_id = $1 AND reconciliation_id = $2 ORDER BY created_at`,
    [tx.tenantId, reconciliationId],
  );
  return { issuance: iss.rows, settlement: set.rows };
}

export async function listCases(tx: TenantTx, reconciliationId: string) {
  return (
    await tx.query<{ id: string; kind: string; status: string; expected: unknown; observed: unknown; opened_at: Date; resolved_at: Date | null; resolution_note: string | null }>(
      `SELECT id, kind, status, expected, observed, opened_at, resolved_at, resolution_note FROM reconciliation_cases WHERE tenant_id = $1 AND reconciliation_id = $2 ORDER BY opened_at`,
      [tx.tenantId, reconciliationId],
    )
  ).rows;
}

/** A verified payment received for an order (no chain operation of ours: we did not send it). */
export async function recordInboundPayment(
  tx: TenantTx,
  o: {
    reconciliationId: string;
    partyId: string;
    network: Network;
    tokenContract: string;
    payer: string;
    payee: string;
    expectedAmount: bigint;
    txRef: string;
    observedAmount: bigint;
    block: bigint;
    observedAt: Date;
    requestedBy: string;
  },
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO settlement_intents (tenant_id, network, token_contract, purpose, payer_address, payee_address, amount, reconciliation_id, idempotency_key,
                                     status, requested_by, party_id, direction, observed_tx_ref, observed_amount, observed_block, observed_at)
     VALUES ($1, $2, $3, 'subscription', $4, $5, $6::numeric, $7, gen_random_uuid(), 'completed', $8, $9, 'inbound', $10, $11::numeric, $12::bigint, $13)
     RETURNING id`,
    [tx.tenantId, o.network, o.tokenContract, o.payer, o.payee, o.expectedAmount.toString(), o.reconciliationId, o.requestedBy, o.partyId, o.txRef, o.observedAmount.toString(), o.block.toString(), o.observedAt],
  );
  return r.rows[0]!.id;
}

export async function findInboundPayment(tx: TenantTx, network: Network, txRef: string): Promise<{ id: string; reconciliation_id: string } | undefined> {
  return (
    await tx.query<{ id: string; reconciliation_id: string }>(`SELECT id, reconciliation_id FROM settlement_intents WHERE tenant_id = $1 AND network = $2 AND observed_tx_ref = $3`, [
      tx.tenantId,
      network,
      txRef,
    ])
  ).rows[0];
}

/** Orders still in play, across workspaces, for the reconciliation sweep. */
export async function openOrders(tx: SystemTx, limit = 5_000): Promise<{ tenant_id: string; id: string; status: OrderStatus }[]> {
  return (
    await tx.query<{ tenant_id: string; id: string; status: OrderStatus }>(
      `SELECT tenant_id, id, status FROM rwa_orders WHERE status IN ('open', 'settling', 'issuing', 'exception') ORDER BY created_at LIMIT $1`,
      [limit],
    )
  ).rows;
}
