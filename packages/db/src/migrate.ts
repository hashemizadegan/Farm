import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "./pool";

// Overridable because bundled builds (apps/api/dist) no longer sit next to the SQL files.
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

// Arbitrary constant: serialises concurrent migration runs (e.g. two deploys starting at once).
const LOCK_ID = 727_271_001;

interface MigrationFile {
  version: string;
  up: string;
  down?: string;
  checksum: string;
}

async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".up.sql")).sort();
  return Promise.all(
    files.map(async (f) => {
      const version = f.replace(/\.up\.sql$/, "");
      const up = await readFile(path.join(dir, f), "utf8");
      const down = await readFile(path.join(dir, `${version}.down.sql`), "utf8").catch(() => undefined);
      return { version, up, down, checksum: createHash("sha256").update(up).digest("hex") };
    }),
  );
}

async function ensureTable(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);
}

export async function migrationStatus(pool: Pool) {
  await ensureTable(pool);
  const all = await loadMigrations();
  const applied = new Map(
    (await pool.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations")).rows.map(
      (r) => [r.version, r.checksum],
    ),
  );
  return all.map((m) => ({
    version: m.version,
    applied: applied.has(m.version),
    checksumMismatch: applied.has(m.version) && applied.get(m.version) !== m.checksum,
  }));
}

export async function migrateUp(pool: Pool, log: (msg: string) => void = () => undefined): Promise<string[]> {
  await ensureTable(pool);
  const client = await pool.connect();
  const appliedNow: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    const applied = new Map(
      (await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations")).rows.map(
        (r) => [r.version, r.checksum],
      ),
    );
    for (const m of await loadMigrations()) {
      const prev = applied.get(m.version);
      if (prev) {
        if (prev !== m.checksum) throw new Error(`migration ${m.version} was modified after being applied`);
        continue;
      }
      log(`applying ${m.version}`);
      await client.query("BEGIN");
      try {
        await client.query(m.up);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [m.version, m.checksum]);
        await client.query("COMMIT");
        appliedNow.push(m.version);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${m.version} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return appliedNow;
}

/**
 * Why a down migration must not run here, or null when it may. Down migrations drop tables, so they are
 * refused wherever the app is deployed (staging and production alike) unless an operator sets
 * ALLOW_DESTRUCTIVE_MIGRATIONS=true for that one run; deployed rollbacks restore from backup instead.
 */
export function downMigrationRefusal(env: { APP_ENV?: string; ALLOW_DESTRUCTIVE_MIGRATIONS?: string }): string | null {
  const deployed = env.APP_ENV === "staging" || env.APP_ENV === "production";
  if (deployed && env.ALLOW_DESTRUCTIVE_MIGRATIONS !== "true") {
    return `down migrations are blocked in ${env.APP_ENV}; restore from backup instead (or set ALLOW_DESTRUCTIVE_MIGRATIONS=true for this run)`;
  }
  return null;
}

/** Reverts the most recent migration. Intended for development; see the rollback runbook for production. */
export async function migrateDown(pool: Pool, log: (msg: string) => void = () => undefined): Promise<string | null> {
  await ensureTable(pool);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    const last = (
      await client.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
    ).rows[0];
    if (!last) return null;
    const m = (await loadMigrations()).find((x) => x.version === last.version);
    if (!m?.down) throw new Error(`no down migration for ${last.version}`);
    log(`reverting ${m.version}`);
    await client.query("BEGIN");
    await client.query(m.down);
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [m.version]);
    await client.query("COMMIT");
    return m.version;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
