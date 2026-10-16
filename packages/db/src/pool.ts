import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
  connectionString: string;
  max?: number;
  ssl?: boolean;
  applicationName?: string;
}

export function createPool(opts: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    ssl: opts.ssl ? { rejectUnauthorized: true } : undefined,
    application_name: opts.applicationName ?? "metafarm",
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });
}

export async function pingDatabase(pool: pg.Pool): Promise<boolean> {
  const r = await pool.query<{ ok: number }>("SELECT 1 AS ok");
  return r.rows[0]?.ok === 1;
}
