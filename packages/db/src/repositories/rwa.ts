import type { Discrepancy, IntentView, KycStatus, Network, OrderKind, OrderStatus, OrderView, PartyCompliance, PartyKind, ScreeningOutcome, WalletCompliance } from "@metafarm/domain";
import type { TenantTx } from "../tenant";

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
  o: { kind: OrderKind; partyId: string; representationId: string | null; shareAmount: bigint | null; settlementNetwork: Network; tokenContract: string; settlementAmount: bigint; createdBy: string },
): Promise<{ id: string; reconciliationId: string }> {
  const r = await tx.query<{ id: string; reconciliation_id: string }>(
    `INSERT INTO rwa_orders (tenant_id, kind, party_id, representation_id, share_amount, settlement_network, token_contract, settlement_amount, created_by)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8::numeric, $9) RETURNING id, reconciliation_id`,
    [tx.tenantId, o.kind, o.partyId, o.representationId, o.shareAmount?.toString() ?? null, o.settlementNetwork, o.tokenContract, o.settlementAmount.toString(), o.createdBy],
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
  const set = await tx.query<{ purpose: IntentView["purpose"]; amount: string; status: IntentView["status"]; confirmed: number; done_at: Date | null }>(
    `SELECT i.purpose, i.amount::text, i.status, ${confirmed} AS confirmed, ${lastDone} AS done_at FROM settlement_intents i WHERE i.tenant_id = $1 AND i.reconciliation_id = $2`,
    [tx.tenantId, row.reconciliation_id, "settlement"],
  );
  const big = (s: string | null) => (s === null ? null : BigInt(s));
  return {
    reconciliationId: row.reconciliation_id,
    status: row.status,
    order: { kind: row.kind, shareAmount: big(row.share_amount), settlementAmount: BigInt(row.settlement_amount), createdAt: row.created_at },
    intents: [
      ...iss.rows.map((i) => ({ side: "issuance" as const, action: i.action, amount: big(i.amount), status: i.status, confirmedOperations: i.confirmed, ...(i.done_at ? { completedAt: i.done_at } : {}) })),
      ...set.rows.map((i) => ({ side: "settlement" as const, purpose: i.purpose, amount: big(i.amount), status: i.status, confirmedOperations: i.confirmed, ...(i.done_at ? { completedAt: i.done_at } : {}) })),
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
