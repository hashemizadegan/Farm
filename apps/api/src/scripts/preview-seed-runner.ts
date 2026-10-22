/**
 * One-off seed runner for an isolated preview (Dockerfile target `seed-runner`; never part of the api, web, worker
 * or scheduler images). Checks `previewSeedRefusal` against the target database, then runs the existing seeds:
 *   1. `pnpm --filter @metafarm/db seed`   (demo workspace; refuses staging/production itself)
 *   2. `pnpm --filter @metafarm/api seed:yield` (simulation cycles; refuses anything but development/test itself)
 * Both are idempotent. It mints no tokens and prints no secret: dev tokens are minted by the operator offline
 * (`pnpm --filter @metafarm/api dev-token <subject>` with the preview DEV_AUTH_SECRET; no database needed).
 *
 * Usage: `pnpm --filter @metafarm/api preview-seed`, or in the seed-runner container its default command
 * (`node --import tsx src/scripts/preview-seed-runner.ts` in /repo/apps/api). The seeds run the same way, with
 * `node --import tsx`, so the container needs no package manager at run time.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPool, withSystem } from "@metafarm/db";
import { previewSeedRefusal } from "./preview-seed-guard";

const fail = (msg: string): never => {
  console.error(`[preview-seed] refused: ${msg}`);
  process.exit(1);
};

// Checked before any connection.
if (!process.env.APP_ENV || !["development", "test"].includes(process.env.APP_ENV)) {
  fail(previewSeedRefusal({ appEnv: process.env.APP_ENV, tenantSlugs: [], nonDevUsers: 0, latestMigration: null })!);
}
const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL is required");
if (!process.env.DEV_AUTH_SECRET) fail("DEV_AUTH_SECRET is required (the yield seed signs in its dev users)");

const pool = createPool({ connectionString: url!, max: 1 });
const facts = await (async () => {
  try {
    return await withSystem(pool, async (tx) => {
      // An unmigrated database has neither table: report no migrations (refused below) instead of failing on a query.
      const exists = async (t: string) => Boolean((await tx.query<{ t: string | null }>("SELECT to_regclass($1)::text AS t", [t])).rows[0]?.t);
      const latest = (await exists("public.schema_migrations"))
        ? ((await tx.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")).rows[0]?.version ?? null)
        : null;
      const slugs = (await exists("public.tenants")) ? (await tx.query<{ slug: string }>("SELECT slug FROM tenants")).rows.map((r) => r.slug) : [];
      const nonDevUsers = (await exists("public.users")) ? ((await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE oidc_issuer <> 'dev'")).rows[0]?.n ?? 0) : 0;
      return { appEnv: process.env.APP_ENV, tenantSlugs: slugs, nonDevUsers, latestMigration: latest };
    });
  } finally {
    await pool.end();
  }
})();
const refusal = previewSeedRefusal(facts);
if (refusal) fail(refusal);

console.log(`[preview-seed] checks passed (APP_ENV=${facts.appEnv}, migrations through ${facts.latestMigration}, workspaces: ${facts.tenantSlugs.length})`);
// Each seed runs from its own package directory, where its dependencies (tsx included) resolve.
const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const seeds = [
  { name: "demo workspace (@metafarm/db seed)", cwd: at("../../../../packages/db/"), file: "src/scripts/seed.ts" },
  { name: "simulation yield cycles (@metafarm/api seed:yield)", cwd: at("../../"), file: "src/scripts/seed-yield-simulation.ts" },
];
for (const seed of seeds) {
  console.log(`[preview-seed] running ${seed.name}`);
  execFileSync(process.execPath, ["--import", "tsx", seed.file], { cwd: seed.cwd, stdio: "inherit", env: process.env });
}
console.log("[preview-seed] done");
