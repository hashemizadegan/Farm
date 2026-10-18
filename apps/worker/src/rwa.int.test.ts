/** RWA reconciliation sweep against a real database. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFarm, createOrder, createParty, createPool, createTenantWithOwner, migrateUp, recordInboundPayment, upsertUserBySubject, withSystem, withTenant, type Pool } from "@metafarm/db";
import { createLogger } from "@metafarm/observability";
import { rwaReconciliationSweepHandler } from "./handlers/rwa";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const ctx = { log: createLogger({ service: "test", level: "silent" }), attempt: 1, jobId: "t" };

d("RWA reconciliation sweep", () => {
  let pool: Pool;
  let tenant: string;
  let user: string;
  let party: string;
  let representation: string;
  const status = (id: string) => withTenant(pool, tenant, async (tx) => (await tx.query(`SELECT status FROM rwa_orders WHERE id = $1`, [id])).rows[0].status as string);
  const cases = (recon: string) =>
    withTenant(pool, tenant, async (tx) => (await tx.query(`SELECT kind FROM reconciliation_cases WHERE reconciliation_id = $1 ORDER BY kind`, [recon])).rows.map((r) => r.kind as string));

  async function paidOrder(paid: bigint, tx: string) {
    return withTenant(pool, tenant, async (t) => {
      const o = await createOrder(t, { kind: "subscription", partyId: party, representationId: representation, shareAmount: 1_000n, settlementNetwork: "tron-nile", tokenContract: "TToken", settlementAmount: 50n, createdBy: user });
      await recordInboundPayment(t, {
        reconciliationId: o.reconciliationId,
        partyId: party,
        network: "tron-nile",
        tokenContract: "TToken",
        payer: "TPayer",
        payee: "TTreasury",
        expectedAmount: 50n,
        txRef: tx,
        observedAmount: paid,
        block: 1n,
        observedAt: new Date(),
        requestedBy: user,
      });
      await t.query(`UPDATE rwa_orders SET status = 'issuing' WHERE id = $1`, [o.id]);
      return o;
    });
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
    const sfx = Math.random().toString(36).slice(2, 8);
    user = (await upsertUserBySubject(pool, { issuer: "test", subject: `rs-${sfx}` })).id;
    tenant = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `rs-${sfx}`, name: "Recon", ownerUserId: user }));
    const farm = await withTenant(pool, tenant, (tx) => createFarm(tx, { name: "F", timezone: "UTC", createdBy: user }));
    representation = await withTenant(pool, tenant, async (tx) => {
      const a = (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'farm_share', 'Shares') RETURNING id`, [tx.tenantId, farm.id])).rows[0]!.id;
      return (await tx.query<{ id: string }>(`INSERT INTO asset_representations (tenant_id, asset_id, rail, network) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'solana-devnet') RETURNING id`, [tx.tenantId, a])).rows[0]!.id;
    });
    party = await withTenant(pool, tenant, (tx) => createParty(tx, { kind: "person", displayName: "Investor", createdBy: user }));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("stops an order paid with the wrong amount, and reports a late issuance without stopping", async () => {
    const wrong = await paidOrder(49n, `${"a".repeat(63)}1`);
    const late = await paidOrder(50n, `${"a".repeat(63)}2`);
    const sweep = rwaReconciliationSweepHandler(pool, 30, () => new Date(Date.now() + 2 * 3_600_000));
    await sweep({ bucket: "b" }, ctx);
    expect(await status(wrong.id)).toBe("exception");
    expect(await cases(wrong.reconciliationId)).toEqual(["amount_mismatch", "missing_issuance"]);
    expect(await status(late.id)).toBe("issuing");
    expect(await cases(late.reconciliationId)).toEqual(["missing_issuance"]);
    // Again: no duplicate cases.
    await sweep({ bucket: "b2" }, ctx);
    expect(await cases(late.reconciliationId)).toEqual(["missing_issuance"]);
  });
});
