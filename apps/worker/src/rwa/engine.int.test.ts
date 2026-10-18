/** The execution engine against a real database, with simulated chains. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addWallet,
  createFarm,
  createOrder,
  createParty,
  createPool,
  createTenantWithOwner,
  migrateUp,
  recordInboundPayment,
  recordScreening,
  setKyc,
  upsertUserBySubject,
  withSystem,
  withTenant,
  type Pool,
} from "@metafarm/db";
import type { AssetIssuancePort, ChainObservation, ChainObservationPort, IssuanceRequest, PreparedTransaction } from "@metafarm/domain";
import { createLogger } from "@metafarm/observability";
import { rwaReconciliationSweepHandler } from "../handlers/rwa";
import { runTick, type EngineDeps } from "./engine";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const log = createLogger({ service: "test", level: "silent" });

/** A chain we script: what each signature's fate is, and whether sending fails. */
function fakeSolana() {
  const fate = new Map<string, ChainObservation["status"]>();
  const prepared: IssuanceRequest[] = [];
  const sent: string[] = [];
  let refuse: string | undefined;
  const issuance: AssetIssuancePort = {
    prepareCreateMint: async () => {
      throw new Error("not used");
    },
    prepareIssuance: async (r) => {
      prepared.push(r);
      const txRef = `sig-${randomUUID()}`;
      return { network: r.network, txRef, wire: Buffer.from(txRef).toString("base64"), validity: { lastValidBlockHeight: 1_000n }, fees: { priorityFeeMicroLamports: 5n }, summary: { action: r.action } };
    },
  };
  const observer: ChainObservationPort = {
    submit: async (p: PreparedTransaction) => {
      if (refuse) throw Object.assign(new Error(refuse), { definitive: true });
      sent.push(p.txRef);
      if (!fate.has(p.txRef)) fate.set(p.txRef, "pending");
    },
    observe: async (t) => ({ status: fate.get(t.txRef) ?? "not_found", slotOrBlock: 42n }),
  };
  return {
    rails: { solana: { network: "solana-devnet" as const, issuance, observer } },
    fate,
    prepared,
    sent,
    refuseWith: (m: string | undefined) => (refuse = m),
  };
}

d("RWA execution engine", () => {
  let pool: Pool;
  let tenant: string;
  let user: string;
  let representation: string;
  const chain = fakeSolana();
  const deps = (): EngineDeps => ({ pool, rails: chain.rails, policy: { screeningMaxAgeDays: 30, blockedJurisdictions: [] }, mainnetEnabled: false, now: () => new Date(), log });
  const tick = (n = 1) => (async () => {
    for (let i = 0; i < n; i++) await runTick(deps());
  })();
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[]) => withTenant(pool, tenant, async (tx) => (await tx.query(sql, params)).rows as T[]);

  /** A verified, screened investor with a paid subscription. */
  async function paidSubscription(): Promise<{ orderId: string; recon: string; party: string; walletId: string; holder: string }> {
    const holder = `Holder${randomUUID().replace(/-/g, "").slice(0, 32)}`;
    return withTenant(pool, tenant, async (tx) => {
      const party = await createParty(tx, { kind: "person", displayName: "Investor", jurisdiction: "AE", createdBy: user });
      await setKyc(tx, party, { status: "verified", reference: "kyc-1", expiresAt: new Date(Date.now() + 86_400_000 * 365), verifiedBy: user });
      const walletId = await addWallet(tx, party, "solana-devnet", holder);
      await recordScreening(tx, { subject: "party", partyId: party }, { provider: "p", providerReference: "r1", outcome: "clear", reasons: [], checkedAt: new Date(), recordedBy: user });
      await recordScreening(tx, { subject: "wallet", walletId }, { provider: "p", providerReference: "r2", outcome: "clear", reasons: [], checkedAt: new Date(), recordedBy: user });
      const o = await createOrder(tx, {
        kind: "subscription",
        partyId: party,
        representationId: representation,
        shareAmount: 2_500_000n,
        settlementNetwork: "tron-nile",
        tokenContract: "TToken",
        settlementAmount: 100n,
        investorTronAddress: "TPayer",
        investorSolanaAddress: holder,
        createdBy: user,
      });
      await recordInboundPayment(tx, {
        reconciliationId: o.reconciliationId,
        partyId: party,
        network: "tron-nile",
        tokenContract: "TToken",
        payer: "TPayer",
        payee: "TTreasury",
        expectedAmount: 100n,
        txRef: randomUUID().replace(/-/g, "").padEnd(64, "0"),
        observedAmount: 100n,
        block: 1n,
        observedAt: new Date(),
        requestedBy: user,
      });
      await tx.query(`UPDATE rwa_orders SET status = 'issuing' WHERE id = $1`, [o.id]);
      return { orderId: o.id, recon: o.reconciliationId, party, walletId, holder };
    });
  }

  const intentOf = async (recon: string) => (await q<{ id: string; status: string }>(`SELECT id, status FROM issuance_intents WHERE reconciliation_id = $1 ORDER BY created_at`, [recon]));
  const opsOf = async (intentId: string) => q<{ attempt: number; state: string; tx_ref: string | null; error: string | null }>(`SELECT attempt, state, tx_ref, error FROM chain_operations WHERE intent_id = $1 ORDER BY attempt`, [intentId]);

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
    const sfx = Math.random().toString(36).slice(2, 8);
    user = (await upsertUserBySubject(pool, { issuer: "test", subject: `eng-${sfx}` })).id;
    tenant = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `eng-${sfx}`, name: "Engine", ownerUserId: user }));
    const farm = await withTenant(pool, tenant, (tx) => createFarm(tx, { name: "F", timezone: "UTC", createdBy: user }));
    representation = await withTenant(pool, tenant, async (tx) => {
      const a = (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'farm_share', 'Shares') RETURNING id`, [tx.tenantId, farm.id])).rows[0]!.id;
      return (
        await tx.query<{ id: string }>(
          `INSERT INTO asset_representations (tenant_id, asset_id, rail, network, decimals, mint_address, status) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'solana-devnet', 6, $3, 'active') RETURNING id`,
          [tx.tenantId, a, `Mint${sfx}${"1".repeat(30)}`],
        )
      ).rows[0]!.id;
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("mints after a verified payment, follows it to finality, and completes the order", async () => {
    const o = await paidSubscription();
    await tick(); // intent, attempt 1, compliance gate
    const [intent] = await intentOf(o.recon);
    expect(intent).toMatchObject({ status: "in_progress" });
    expect(await opsOf(intent!.id)).toEqual([expect.objectContaining({ attempt: 1, state: "policy_approved" })]);
    await tick(); // prepared (signed and stored)
    const [prepared] = await opsOf(intent!.id);
    expect(prepared).toMatchObject({ state: "prepared" });
    expect(chain.prepared.at(-1)).toMatchObject({ action: "mint", amount: 2_500_000n, holderAddress: o.holder, decimals: 6 });
    await tick(); // submitted
    expect((await opsOf(intent!.id))[0]!.state).toBe("submitted");
    chain.fate.set(prepared!.tx_ref!, "final");
    await tick(2); // observed + confirmed, then business_completed
    await tick(); // intent completed
    expect((await opsOf(intent!.id))[0]!.state).toBe("business_completed");
    expect((await intentOf(o.recon))[0]!.status).toBe("completed");
    const log = await q<{ to_state: string }>(`SELECT t.to_state FROM chain_operation_transitions t JOIN chain_operations c ON c.id = t.operation_id WHERE c.intent_id = $1 ORDER BY t.id`, [intent!.id]);
    expect(log.map((r) => r.to_state)).toEqual(["policy_approved", "prepared", "submitted", "observed", "confirmed", "business_completed"]);
    // No second mint, ever.
    await tick(3);
    expect(await intentOf(o.recon)).toHaveLength(1);
    await rwaReconciliationSweepHandler(pool, 30)({ bucket: "b" }, { log, attempt: 1, jobId: "t" });
    expect((await q<{ status: string }>(`SELECT status FROM rwa_orders WHERE id = $1`, [o.orderId]))[0]!.status).toBe("completed");
  });

  it("makes a new attempt only after the previous one provably expired", async () => {
    const o = await paidSubscription();
    await tick(3); // approved, prepared, submitted
    const [intent] = await intentOf(o.recon);
    const first = (await opsOf(intent!.id))[0]!;
    expect(first.state).toBe("submitted");
    // Still pending: re-sent as is, never re-signed.
    const signed = chain.prepared.length;
    await tick(2);
    expect(chain.prepared.length).toBe(signed);
    expect(chain.sent.filter((s) => s === first.tx_ref).length).toBeGreaterThan(1);
    chain.fate.set(first.tx_ref!, "expired");
    await tick(); // attempt 1 expired
    await tick(); // attempt 2 created
    const ops = await opsOf(intent!.id);
    expect(ops.map((x) => [x.attempt, x.state])).toEqual([
      [1, "expired"],
      [2, "policy_approved"],
    ]);
  });

  it("refuses to sign when compliance no longer passes, and stops on a definitive refusal", async () => {
    const blocked = await paidSubscription();
    await withTenant(pool, tenant, (tx) =>
      recordScreening(tx, { subject: "wallet", walletId: blocked.walletId }, { provider: "p", providerReference: "r3", outcome: "blocked", reasons: ["listed"], checkedAt: new Date(), recordedBy: user }),
    );
    await tick(2);
    const [intent] = await intentOf(blocked.recon);
    expect((await opsOf(intent!.id))[0]).toMatchObject({ state: "policy_rejected", error: "wallet_blocked" });
    expect((await intentOf(blocked.recon))[0]!.status).toBe("policy_rejected");

    const refused = await paidSubscription();
    chain.refuseWith("Transaction simulation failed: custom program error: 0x5");
    await tick(3);
    chain.refuseWith(undefined);
    const [r] = await intentOf(refused.recon);
    expect((await opsOf(r!.id))[0]).toMatchObject({ state: "failed", error: "Transaction simulation failed: custom program error: 0x5" });
    await tick();
    expect((await intentOf(refused.recon))[0]!.status).toBe("failed");
  });
});
