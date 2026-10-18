/** Parties, screenings, the compliance view, orders and reconciliation cases against a real database. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { complianceDecision, reconcileOrder } from "@metafarm/domain";
import { createPool, type Pool } from "./pool";
import { migrateUp } from "./migrate";
import { withSystem, withTenant, type TenantTx } from "./tenant";
import { createTenantWithOwner, upsertUserBySubject } from "./repositories/identity";
import { createFarm } from "./repositories/farms";
import { addWallet, complianceView, createOrder, createParty, openReconciliationCases, orderForReconciliation, recordScreening, setKyc } from "./repositories/rwa";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const TRON = "TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW";
const SOL = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";

d("RWA orders and compliance", () => {
  let pool: Pool;
  let tenant: string;
  let user: string;
  let party: string;
  let representation: string;
  const inT = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(pool, tenant, fn);

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
    const sfx = Math.random().toString(36).slice(2, 8);
    user = (await upsertUserBySubject(pool, { issuer: "test", subject: `ord-${sfx}` })).id;
    tenant = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `ord-${sfx}`, name: "Orders", ownerUserId: user }));
    const farm = (await inT((tx) => createFarm(tx, { name: "Grove", timezone: "Asia/Tehran", createdBy: user }))).id;
    representation = await inT(async (tx) => {
      const a = (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'farm_share', 'Grove shares') RETURNING id`, [tx.tenantId, farm])).rows[0]!.id;
      return (await tx.query<{ id: string }>(`INSERT INTO asset_representations (tenant_id, asset_id, rail, network, decimals) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'solana-devnet', 6) RETURNING id`, [tx.tenantId, a])).rows[0]!.id;
    });
    party = await inT((tx) => createParty(tx, { kind: "person", displayName: "First investor", jurisdiction: "AE", createdBy: user }));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("feeds the gate from recorded KYC and screenings, newest first", async () => {
    const policy = { screeningMaxAgeDays: 30, blockedJurisdictions: [] };
    const now = new Date();
    const wallets = [{ network: "tron-nile" as const, address: TRON }];
    let v = (await inT((tx) => complianceView(tx, party, wallets)))!;
    expect(complianceDecision(v.party, v.wallets, policy, now).reasons).toEqual(["kyc_not_verified", "party_unscreened", "wallet_unscreened"]);

    await inT(async (tx) => {
      await setKyc(tx, party, { status: "verified", reference: "case-123", expiresAt: new Date(Date.now() + 365 * 86_400_000), verifiedBy: user });
      const w = await addWallet(tx, party, "tron-nile", TRON);
      await recordScreening(tx, { subject: "party", partyId: party }, { provider: "test-provider", providerReference: "p-1", outcome: "review", reasons: ["name match"], checkedAt: new Date(Date.now() - 60_000), recordedBy: user });
      await recordScreening(tx, { subject: "party", partyId: party }, { provider: "test-provider", providerReference: "p-2", outcome: "clear", reasons: [], checkedAt: new Date(), recordedBy: user });
      await recordScreening(tx, { subject: "wallet", walletId: w }, { provider: "test-provider", providerReference: "w-1", outcome: "clear", reasons: [], checkedAt: new Date(), recordedBy: user });
    });
    v = (await inT((tx) => complianceView(tx, party, wallets)))!;
    expect(complianceDecision(v.party, v.wallets, policy, now)).toEqual({ allowed: true, reasons: [] });
    // Someone else's address is not this party's wallet.
    v = (await inT((tx) => complianceView(tx, party, [{ network: "solana-devnet", address: SOL }])))!;
    expect(v.wallets[0]!.screening).toBeNull();
  });

  it("keeps screenings as an unchangeable record, and verified KYC needs a provider reference", async () => {
    await expect(inT((tx) => tx.query(`UPDATE compliance_screenings SET outcome = 'clear' WHERE tenant_id = $1`, [tenant]))).rejects.toThrow();
    await expect(inT((tx) => tx.query(`UPDATE parties SET kyc_status = 'verified', kyc_reference = NULL WHERE id = $1`, [party]))).rejects.toThrow(/check constraint/);
  });

  it("reconciles an order from its intents and opens one case per discrepancy", async () => {
    const order = await inT((tx) =>
      createOrder(tx, { kind: "subscription", partyId: party, representationId: representation, shareAmount: 1_000_000n, settlementNetwork: "tron-nile", tokenContract: "TXYZ", settlementAmount: 50_000_000n, createdBy: user }),
    );
    // Paid for less than the order says, long enough ago that issuance is overdue.
    await inT(async (tx) => {
      const s = (
        await tx.query<{ id: string }>(
          `INSERT INTO settlement_intents (tenant_id, network, token_contract, purpose, payer_address, payee_address, amount, reconciliation_id, idempotency_key, status, party_id)
           VALUES ($1, 'tron-nile', 'TXYZ', 'subscription', $2, 'TTreasury1111111111111111111111111', 49000000, $3, $4, 'completed', $5) RETURNING id`,
          [tx.tenantId, TRON, order.reconciliationId, randomUUID(), party],
        )
      ).rows[0]!.id;
      const op = (await tx.query<{ id: string }>(`INSERT INTO chain_operations (tenant_id, intent_type, intent_id, attempt, network) VALUES ($1, 'settlement', $2, 1, 'tron-nile') RETURNING id`, [tx.tenantId, s])).rows[0]!.id;
      for (const [state, ref] of [["policy_approved"], ["prepared", "ab".repeat(32)], ["submitted"], ["observed"], ["confirmed"], ["business_completed"]] as const) {
        await tx.query(`UPDATE chain_operations SET state = $2, tx_ref = coalesce($3, tx_ref) WHERE id = $1`, [op, state, ref ?? null]);
      }
    });
    const view = (await inT((tx) => orderForReconciliation(tx, order.id)))!;
    expect(view.intents).toEqual([expect.objectContaining({ side: "settlement", purpose: "subscription", amount: 49_000_000n, status: "completed", confirmedOperations: 1 })]);
    const later = new Date(Date.now() + 2 * 3_600_000);
    const found = reconcileOrder(view.order, view.intents, later, 30);
    expect(found.map((x) => x.kind)).toEqual(["amount_mismatch", "missing_issuance"]);
    expect(await inT((tx) => openReconciliationCases(tx, order.reconciliationId, found))).toBe(2);
    // Running again does not duplicate open cases.
    expect(await inT((tx) => openReconciliationCases(tx, order.reconciliationId, found))).toBe(0);
  });

  it("refuses intents that belong to no order", async () => {
    await expect(
      inT((tx) =>
        tx.query(
          `INSERT INTO settlement_intents (tenant_id, network, token_contract, purpose, payer_address, payee_address, amount, reconciliation_id, idempotency_key)
           VALUES ($1, 'tron-nile', 'T', 'distribution', 'a', 'b', 1, $2, $3)`,
          [tenant, randomUUID(), randomUUID()],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});
