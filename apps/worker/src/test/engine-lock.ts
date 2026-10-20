/**
 * The RWA engine and the reconciliation sweep work across every workspace in the database, so two
 * test files that run them at the same time would drive each other's orders with the wrong
 * simulated chain. Such files hold this lock for their whole run, so they take turns even when
 * the test runner runs files in parallel.
 */
import type { Pool } from "@metafarm/db";

const ENGINE_TEST_LOCK = 73_060_022;

/** Waits for the lock; call the returned function to give it back. Long enough for the other file to finish. */
export async function takeEngineTestLock(pool: Pool): Promise<() => Promise<void>> {
  const client = await pool.connect();
  await client.query(`SELECT pg_advisory_lock($1)`, [ENGINE_TEST_LOCK]);
  return async () => {
    try {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ENGINE_TEST_LOCK]);
    } finally {
      client.release();
    }
  };
}

/** How long a test file may wait for the lock (the others' whole run). */
export const ENGINE_TEST_LOCK_WAIT_MS = 600_000;
