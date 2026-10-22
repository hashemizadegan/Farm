/**
 * Guard for the preview seed runner (`preview-seed-runner.ts`). Pure, so it is unit-tested without a database.
 *
 * The runner seeds a **newly provisioned, isolated** preview database with the demo workspace and the simulation
 * yield cycles. It refuses unless every condition holds:
 * - APP_ENV is exactly `development` or `test` (an allow-list: anything else, unset included, is refused);
 * - the database holds no workspace other than the development seed's own (`demo` and `other`, created by
 *   `packages/db/src/scripts/seed.ts`), and no user from an identity issuer other than `dev`: a database with real
 *   workspaces or real (OIDC) sign-ins is not a fresh preview database, whatever its name or host;
 * - migrations are applied at least through 0029 (the yield tables the seed writes).
 */
export const PREVIEW_SEED_MIN_MIGRATION = "0029";
export const PREVIEW_SEED_APP_ENVS: readonly string[] = ["development", "test"];
/** The workspaces the development seed creates (packages/db/src/scripts/seed.ts); a re-run finds exactly these. */
export const DEV_SEED_TENANT_SLUGS: readonly string[] = ["demo", "other"];

export interface PreviewSeedFacts {
  appEnv: string | undefined;
  /** Slugs of every tenant in the database. */
  tenantSlugs: readonly string[];
  /** Users whose identity issuer is not the development provider (`dev`). */
  nonDevUsers: number;
  /** The latest applied migration version (e.g. `0029_yield_claim_intent_batches`), or null when none. */
  latestMigration: string | null;
}

export function previewSeedRefusal(f: PreviewSeedFacts): string | null {
  if (!f.appEnv || !PREVIEW_SEED_APP_ENVS.includes(f.appEnv)) {
    return `APP_ENV must be ${PREVIEW_SEED_APP_ENVS.join(" or ")} (got ${f.appEnv ?? "nothing"}): the preview seed is simulation data for an isolated database`;
  }
  const others = f.tenantSlugs.filter((s) => !DEV_SEED_TENANT_SLUGS.includes(s));
  if (others.length > 0) {
    return `the database holds ${others.length} workspace(s) the development seed did not create: it is not a fresh, isolated preview database`;
  }
  if (f.nonDevUsers > 0) {
    return `the database holds ${f.nonDevUsers} user(s) from a real identity provider: it is not a fresh, isolated preview database`;
  }
  if (f.latestMigration === null || f.latestMigration.slice(0, 4) < PREVIEW_SEED_MIN_MIGRATION) {
    return `migrations must be applied through ${PREVIEW_SEED_MIN_MIGRATION} first (latest: ${f.latestMigration ?? "none"})`;
  }
  return null;
}
