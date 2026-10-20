/**
 * The RWA engine and the reconciliation sweep work across every workspace in the database, so two
 * test files that run them at the same time would drive each other's orders with the wrong
 * simulated chain. Such files hold this lock for their whole run, so they take turns even when
 * the test runner runs files in parallel.
 */
import type { Pool } from "@metafarm/db";

const ENGINE_TEST_LOCK = 73_060_022;

/** How long a test file may wait for the lock (the others' whole run). */
export const ENGINE_TEST_LOCK_WAIT_MS = 600_000;

/** Waits for the lock; call the returned function to give it back. Long enough for the other file to finish. */
export async function takeEngineTestLock(pool: Pool): Promise<() => Promise<void>> {
  const client = await pool.connect();
  // Polled with short statements: the pool's statement timeout would cancel a blocking wait.
  const deadline = Date.now() + ENGINE_TEST_LOCK_WAIT_MS - 5_000;
  try {
    for (;;) {
      const r = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [ENGINE_TEST_LOCK]);
      if (r.rows[0]?.ok) break;
      if (Date.now() > deadline) throw new Error("another engine test file held the lock for too long");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch (err) {
    client.release(); // or the pool would never end
    throw err;
  }
  return async () => {
    try {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ENGINE_TEST_LOCK]);
    } finally {
      client.release();
    }
  };
}
