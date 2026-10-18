/** RWA tables against a real database: lifecycle guard, one live attempt, tenant isolation, integrity checks. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "./pool";
import { migrateUp } from "./migrate";
import { withSystem, withTenant, type TenantTx } from "./tenant";
import { createTenantWithOwner, upsertUserBySubject } from "./repositories/identity";
import { createFarm } from "./repositories/farms";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("RWA rails schema", () => {
  let pool: Pool;
  let tenantA: string;
  let tenantB: string;
  let user: string;
  let other: string;
  let farm: string;
  let representation: string;
  let reconciliation: string;

  const inA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(pool, tenantA, fn);
  const newIntent = (tx: TenantTx, o: { requestedBy?: string; approvedBy?: string } = {}) =>
    tx
      .query<{ id: string }>(
        `INSERT INTO issuance_intents (tenant_id, representation_id, action, amount, holder_address, reconciliation_id, idempotency_key, requested_by, approved_by)
         VALUES ($1, $2, 'mint', 1000, 'HoLdEr1111111111111111111111111111111111111', $3, $4, $5, $6) RETURNING id`,
        [tx.tenantId, representation, reconciliation, randomUUID(), o.requestedBy ?? user, o.approvedBy ?? null],
      )
      .then((r) => r.rows[0]!.id);
  const newOp = (tx: TenantTx, intentId: string, attempt = 1) =>
    tx
      .query<{ id: string }>(
        `INSERT INTO chain_operations (tenant_id, intent_type, intent_id, attempt, network) VALUES ($1, 'issuance', $2, $3, 'solana-devnet') RETURNING id`,
        [tx.tenantId, intentId, attempt],
      )
      .then((r) => r.rows[0]!.id);
  const move = (tx: TenantTx, id: string, state: string, txRef?: string) =>
    tx.query(`UPDATE chain_operations SET state = $2, tx_ref = coalesce($3, tx_ref) WHERE id = $1`, [id, state, txRef ?? null]);

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
    const sfx = Math.random().toString(36).slice(2, 8);
    user = (await upsertUserBySubject(pool, { issuer: "test", subject: `rwa-${sfx}` })).id;
    other = (await upsertUserBySubject(pool, { issuer: "test", subject: `rwa-o-${sfx}` })).id;
    tenantA = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `rwa-a-${sfx}`, name: "A", ownerUserId: user }));
    tenantB = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `rwa-b-${sfx}`, name: "B", ownerUserId: other }));
    farm = (await inA((tx) => createFarm(tx, { name: "Orchard", timezone: "Asia/Tehran", createdBy: user }))).id;
    representation = await inA(async (tx) => {
      const asset = (
        await tx.query<{ id: string }>(
          `INSERT INTO business_assets (tenant_id, farm_id, kind, name, geom, geom_provenance, status, verified_at, verified_by)
           VALUES ($1, $2, 'tree', 'Pistachio tree A-17', ST_SetSRID(ST_MakePoint(56.01, 30.40), 4326), 'gnss', 'verified', now(), $3) RETURNING id`,
          [tx.tenantId, farm, user],
        )
      ).rows[0]!.id;
      return (
        await tx.query<{ id: string }>(
          `INSERT INTO asset_representations (tenant_id, asset_id, rail, network, decimals) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'solana-devnet', 6) RETURNING id`,
          [tx.tenantId, asset],
        )
      ).rows[0]!.id;
    });
    reconciliation = await inA(async (tx) => {
      const party = (await tx.query<{ id: string }>(`INSERT INTO parties (tenant_id, kind, display_name) VALUES ($1, 'person', 'Investor') RETURNING id`, [tx.tenantId])).rows[0]!.id;
      return (
        await tx.query<{ reconciliation_id: string }>(
          `INSERT INTO rwa_orders (tenant_id, kind, party_id, representation_id, share_amount, settlement_network, token_contract, settlement_amount)
           VALUES ($1, 'subscription', $2, $3, 1000, 'tron-nile', 'TXYZ', 50) RETURNING reconciliation_id`,
          [tx.tenantId, party, representation],
        )
      ).rows[0]!.reconciliation_id;
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("refuses verified trees and parcels without geometry, and rails on the wrong network", async () => {
    await expect(
      inA((tx) =>
        tx.query(`INSERT INTO business_assets (tenant_id, farm_id, kind, name, status, verified_at) VALUES ($1, $2, 'parcel', 'Block 9', 'verified', now())`, [tx.tenantId, farm]),
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      inA(async (tx) => {
        const a = (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'farm_share', 'Shares') RETURNING id`, [tx.tenantId, farm])).rows[0]!.id;
        await tx.query(`INSERT INTO asset_representations (tenant_id, asset_id, rail, network) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'tron-nile')`, [tx.tenantId, a]);
      }),
    ).rejects.toThrow(/check constraint/);
  });

  it("walks the lifecycle forward only and logs every step", async () => {
    const op = await inA(async (tx) => newOp(tx, await newIntent(tx)));
    await inA(async (tx) => {
      await move(tx, op, "policy_approved");
      await move(tx, op, "prepared", `sig-${randomUUID()}`);
      await move(tx, op, "submitted");
    });
    // Finality cannot be skipped, and nothing goes backwards.
    await expect(inA((tx) => move(tx, op, "confirmed"))).rejects.toThrow(/cannot go from submitted to confirmed/);
    await expect(inA((tx) => move(tx, op, "prepared"))).rejects.toThrow(/cannot go from submitted to prepared/);
    await inA(async (tx) => {
      await move(tx, op, "observed");
      await move(tx, op, "confirmed");
      await move(tx, op, "business_completed");
    });
    const log = await inA((tx) => tx.query(`SELECT from_state, to_state FROM chain_operation_transitions WHERE operation_id = $1 ORDER BY id`, [op]));
    expect(log.rows.map((r) => r.to_state)).toEqual(["policy_approved", "prepared", "submitted", "observed", "confirmed", "business_completed"]);
    // The record and its history stay as they are.
    await expect(inA((tx) => tx.query(`DELETE FROM chain_operations WHERE id = $1`, [op]))).rejects.toThrow();
    await expect(inA((tx) => tx.query(`UPDATE chain_operation_transitions SET to_state = 'failed' WHERE operation_id = $1`, [op]))).rejects.toThrow();
    await expect(inA((tx) => tx.query(`UPDATE chain_operations SET tx_ref = 'other' WHERE id = $1`, [op]))).rejects.toThrow(/identity is fixed/);
  });

  it("allows one live attempt per intent, and a new attempt only after the last one ended", async () => {
    const intent = await inA((tx) => newIntent(tx));
    const first = await inA((tx) => newOp(tx, intent, 1));
    await expect(inA((tx) => newOp(tx, intent, 2))).rejects.toThrow(/chain_operations_live_idx/);
    await inA(async (tx) => {
      await move(tx, first, "policy_approved");
      await move(tx, first, "prepared", `sig-${randomUUID()}`);
      await move(tx, first, "expired");
    });
    expect(await inA((tx) => newOp(tx, intent, 2))).toBeTruthy();
  });

  it("refuses self-approval", async () => {
    await expect(inA((tx) => newIntent(tx, { requestedBy: user, approvedBy: user }))).rejects.toThrow(/check constraint/);
  });

  it("keeps workspaces apart and financial records from being deleted with them", async () => {
    const seen = await withTenant(pool, tenantB, (tx) => tx.query(`SELECT count(*)::int AS n FROM chain_operations`));
    expect(seen.rows[0].n).toBe(0);
    await expect(
      withTenant(pool, tenantB, (tx) =>
        tx.query(`INSERT INTO settlement_intents (tenant_id, network, token_contract, purpose, payer_address, payee_address, amount, reconciliation_id, idempotency_key)
                  VALUES ($1, 'tron-nile', 'T', 'subscription', 'a', 'b', 1, $2, $3)`, [tenantA, randomUUID(), randomUUID()]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(withSystem(pool, (tx) => tx.query(`DELETE FROM tenants WHERE id = $1`, [tenantA]))).rejects.toThrow(/foreign key/);
  });

  it("drops duplicate telemetry by sensor, metric and time", async () => {
    await inA(async (tx) => {
      const sensor = (
        await tx.query<{ id: string }>(`INSERT INTO sensors (tenant_id, farm_id, name, kind) VALUES ($1, $2, 'Probe 1', 'soil-moisture') RETURNING id`, [tx.tenantId, farm])
      ).rows[0]!.id;
      const row = [tx.tenantId, farm, sensor, "2026-10-18T06:00:00Z"];
      const insert = `INSERT INTO iot_telemetry (tenant_id, farm_id, sensor_id, time, metric, value, unit) VALUES ($1, $2, $3, $4, 'soil_moisture', 0.21, 'fraction_vwc')
                      ON CONFLICT DO NOTHING`;
      expect((await tx.query(insert, row)).rowCount).toBe(1);
      expect((await tx.query(insert, row)).rowCount).toBe(0);
    });
  });
});
