import type { Pool, PoolClient } from "./pool";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare const tenantBrand: unique symbol;
declare const systemBrand: unique symbol;

/**
 * A database client inside a transaction that is bound to exactly one tenant.
 * It can only be obtained from `withTenant`, so repository functions that
 * accept a `TenantTx` cannot be called without a tenant context.
 */
export type TenantTx = PoolClient & { readonly tenantId: string; readonly [tenantBrand]: true };

/** A client with cross-tenant access. Use sparingly; every use should be justified in a comment. */
export type SystemTx = PoolClient & { readonly [systemBrand]: true };

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextError";
  }
}

/**
 * Runs `fn` inside a transaction that:
 *  - switches to the restricted `metafarm_app` role so row-level security applies, and
 *  - sets `app.tenant_id` for the duration of the transaction only (SET LOCAL semantics).
 */
export async function withTenant<T>(pool: Pool, tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new TenantContextError("invalid tenant id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE metafarm_app");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const tx = Object.assign(client, { tenantId }) as TenantTx;
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    // Clear the property so a pooled client is not mistaken for tenant-bound later.
    delete (client as Partial<TenantTx> & { tenantId?: string }).tenantId;
    client.release();
  }
}

export async function withSystem<T>(pool: Pool, fn: (tx: SystemTx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client as SystemTx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
