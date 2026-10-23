/**
 * Database lifecycle of migrations 0019–0033 on a database of its own (created and dropped here):
 * - up from empty through 0033;
 * - row-level security forced, with tenant isolation, on every tenant-scoped table of the line;
 * - application-role grants exactly as reviewed (append-only tables have no UPDATE/DELETE);
 * - every SECURITY DEFINER function of the line pins search_path and is not executable by PUBLIC;
 * - append-only triggers on UPDATE and DELETE where reviewed, calling the shared refusing append_only();
 * - the simulation-only constraints are present;
 * - down 0033 → 0019 step by step leaves the 0018 schema, and up again restores the same catalog.
 * 0030 (realtime outbox), 0031 (registered integrations), 0032 (retention horizons) and 0033 (marketplace, simulation
 * only; read-only for the application role) follow the same rules.
 * Material for docs/delivery/yield-security-review-package-2026-10-22.md §A and §E.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrateDown, migrateUp, type Pool } from "./index";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const DB = `migrations_lifecycle_${process.pid}`;

/** Tenant-scoped tables created by 0019–0033. */
const TENANT_TABLES = [
  "data_commitments",
  "commitment_batches",
  "commitment_batch_leaves",
  "idempotency_records",
  "yield_cycles",
  "yield_cycle_transitions",
  "yield_artifact_sets",
  "yield_ownership_snapshots",
  "yield_allocations",
  "yield_attestations",
  "yield_evidence",
  "yield_inputs",
  "party_account_links",
  "party_account_link_events",
  "yield_simulation_dossiers",
  "yield_frozen_artifacts",
  "yield_claim_leaves",
  "yield_carry_ledgers",
  "yield_claim_intent_batches",
  "realtime_events",
  "integrations",
  "integration_events",
  "realtime_retention_horizons",
  "market_listings",
  "market_orders",
  "market_order_events",
  "market_asset_control",
];

/** metafarm_app privileges per table, as reviewed (§A). */
const GRANTS: Record<string, string[]> = {
  data_commitments: ["SELECT", "INSERT"],
  commitment_batches: ["SELECT", "INSERT"],
  commitment_batch_leaves: ["SELECT", "INSERT"],
  chain_ownership_events: ["SELECT"],
  chain_ownership_cursors: ["SELECT"],
  idempotency_records: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  player_wallets: [],
  player_wallet_challenges: [],
  ownership_source_identities: ["SELECT"],
  yield_cycles: ["SELECT", "INSERT", "UPDATE"],
  yield_cycle_transitions: ["SELECT"],
  yield_artifact_sets: ["SELECT", "INSERT"],
  yield_ownership_snapshots: ["SELECT", "INSERT"],
  yield_allocations: ["SELECT", "INSERT"],
  yield_attestations: ["SELECT", "INSERT"],
  yield_evidence: ["SELECT", "INSERT"],
  yield_inputs: ["SELECT", "INSERT"],
  party_account_links: ["SELECT", "INSERT", "UPDATE"],
  party_account_link_events: ["SELECT"],
  yield_simulation_dossiers: ["SELECT", "INSERT"],
  yield_frozen_artifacts: ["SELECT", "INSERT"],
  yield_claim_leaves: ["SELECT", "INSERT"],
  yield_carry_ledgers: ["SELECT", "INSERT"],
  yield_claim_intent_batches: ["SELECT", "INSERT"],
  realtime_events: ["SELECT", "INSERT"],
  integrations: ["SELECT", "INSERT", "UPDATE"],
  integration_events: ["SELECT", "INSERT"],
  realtime_retention_horizons: ["SELECT"],
  market_listings: ["SELECT"],
  market_orders: ["SELECT"],
  market_order_events: ["SELECT"],
  market_asset_control: ["SELECT"],
};

/** Tables whose rows never change: an append_only() trigger on UPDATE and DELETE. */
const APPEND_ONLY = [
  "yield_cycle_transitions",
  "yield_evidence",
  "yield_inputs",
  "yield_ownership_snapshots",
  "yield_allocations",
  "yield_attestations",
  "party_account_link_events",
  "yield_simulation_dossiers",
  "yield_frozen_artifacts",
  "yield_claim_leaves",
  "yield_carry_ledgers",
  "yield_claim_intent_batches",
  "integration_events",
  "market_order_events",
];

/** The SECURITY DEFINER functions of the line (0024, 0025); any other is unreviewed. */
const DEFINER_FUNCTIONS = ["party_account_links_guard", "party_account_links_proposed", "yield_cycles_created", "yield_cycles_guard"];

d("migrations 0019–0033: lifecycle and catalog", () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool({ connectionString: url!, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
    const u = new URL(url!);
    u.pathname = `/${DB}`;
    pool = createPool({ connectionString: u.toString(), max: 2 });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin?.end();
  });

  const latest = async () => (await pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")).rows[0]?.version;
  const tableExists = async (t: string) => Boolean((await pool.query<{ t: string | null }>("SELECT to_regclass($1)::text AS t", [`public.${t}`])).rows[0]?.t);

  // Sorted: recreated objects come back in creation (OID) order, which differs after down → up.
  async function catalog() {
    const rls = (
      await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY relname`,
        [TENANT_TABLES],
      )
    ).rows;
    const policies = (await pool.query<{ tablename: string; policyname: string }>(`SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY tablename, policyname`, [TENANT_TABLES])).rows;
    const grants: Record<string, string[]> = {};
    for (const t of Object.keys(GRANTS)) {
      grants[t] = [];
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        if ((await pool.query<{ ok: boolean }>("SELECT has_table_privilege('metafarm_app', $1, $2) AS ok", [`public.${t}`, p])).rows[0]?.ok) grants[t]!.push(p);
      }
    }
    return { rls, policies, grants };
  }

  it("applies every migration from an empty database through 0033", async () => {
    const applied = await migrateUp(pool);
    expect(applied.length).toBeGreaterThanOrEqual(30);
    expect(await latest()).toBe("0033_marketplace");
  }, 120_000);

  it("forces row-level security with tenant isolation on every tenant-scoped table of the line", async () => {
    const { rls, policies } = await catalog();
    expect(rls.map((r) => r.relname).sort()).toEqual([...TENANT_TABLES].sort());
    for (const r of rls) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.relforcerowsecurity, r.relname).toBe(true);
      expect(policies.some((p) => p.tablename === r.relname && p.policyname === "tenant_isolation"), r.relname).toBe(true);
    }
  });

  it("grants the application role exactly the reviewed privileges", async () => {
    expect((await catalog()).grants).toEqual(GRANTS);
  });

  it("pins search_path on every SECURITY DEFINER function of the line and denies PUBLIC execution", async () => {
    const rows = (
      await pool.query<{ proname: string; config: string[] | null; public_exec: boolean }>(
        `SELECT p.proname, p.proconfig AS config,
                COALESCE((SELECT bool_or(a.grantee = 0 AND a.privilege_type = 'EXECUTE') FROM aclexplode(p.proacl) a), true) AS public_exec
           FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND (p.proname LIKE 'yield\\_%' OR p.proname LIKE 'party\\_%')`,
      )
    ).rows;
    expect(rows.map((r) => r.proname).sort()).toEqual(DEFINER_FUNCTIONS);
    for (const r of rows) {
      expect(r.config?.some((c) => /^search_path=/.test(c)), r.proname).toBe(true);
      // A null ACL means the default, which lets PUBLIC execute: it must have been revoked explicitly.
      expect(r.public_exec, r.proname).toBe(false);
    }
  });

  it("has append_only() on UPDATE and DELETE for every append-only table, and it refuses", async () => {
    const rows = (
      await pool.query<{ table: string; fn: string; on_update: boolean; on_delete: boolean }>(
        `SELECT c.relname AS table, f.proname AS fn,
                (t.tgtype & 16) <> 0 AS on_update, (t.tgtype & 8) <> 0 AS on_delete
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc f ON f.oid = t.tgfoid
          WHERE NOT t.tgisinternal AND f.proname = 'append_only' AND c.relname = ANY($1)`,
        [APPEND_ONLY],
      )
    ).rows;
    for (const t of APPEND_ONLY) {
      const r = rows.find((x) => x.table === t);
      expect(r, t).toBeDefined();
      expect([r!.on_update, r!.on_delete], t).toEqual([true, true]);
    }
    // The shared function refuses unconditionally (the owner role bypasses grants and RLS, not triggers). Row-level
    // behaviour on seeded rows is covered by yield-schema.int.test.ts and apps/api yield-pipeline.int.test.ts.
    const body = (await pool.query<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE proname = 'append_only'")).rows[0]?.src ?? "";
    expect(body).toMatch(/RAISE EXCEPTION/i);
  });

  it("keeps the simulation-only constraints", async () => {
    const names = (await pool.query<{ conname: string }>("SELECT conname FROM pg_constraint WHERE conname = ANY($1)", [["yield_cycles_real_gate", "yield_evidence_simulation_only"]])).rows.map((r) => r.conname);
    expect(names.sort()).toEqual(["yield_cycles_real_gate", "yield_evidence_simulation_only"]);
    const guards = (
      await pool.query<{ proname: string; src: string }>(
        "SELECT proname, prosrc AS src FROM pg_proc WHERE proname = ANY($1)",
        [["yield_simulation_dossiers_guard", "yield_frozen_artifacts_guard", "yield_carry_ledgers_guard", "yield_claim_intent_batches_guard"]],
      )
    ).rows;
    expect(guards).toHaveLength(4);
    for (const g of guards) expect(g.src, g.proname).toMatch(/simulation/);
  });

  it("reverts 0033 → 0019 one step at a time to the 0018 schema, then re-applies to the same catalog", async () => {
    const before = await catalog();
    const reverted: string[] = [];
    // Compare the four-digit prefix: "0018_cnft_leaf" > "0018" as a string.
    while (((await latest()) ?? "").slice(0, 4) > "0018") {
      const v = await migrateDown(pool);
      expect(v).not.toBeNull();
      reverted.push(v!);
    }
    expect(reverted).toEqual([
      "0033_marketplace",
      "0032_realtime_retention_horizons",
      "0031_integrations",
      "0030_realtime_events",
      "0029_yield_claim_intent_batches",
      "0028_yield_carry_ledgers",
      "0027_yield_frozen_artifacts",
      "0026_yield_simulation_dossiers",
      "0025_party_account_links",
      "0024_yield_core",
      "0023_ownership_source_identities",
      "0022_player_wallets",
      "0021_idempotency",
      "0020_ownership_index",
      "0019_twin_foundation",
    ]);
    expect(await latest()).toBe("0018_cnft_leaf");
    for (const t of Object.keys(GRANTS)) expect(await tableExists(t), t).toBe(false);
    for (const f of DEFINER_FUNCTIONS) {
      expect((await pool.query("SELECT 1 FROM pg_proc WHERE proname = $1", [f])).rowCount, f).toBe(0);
    }

    expect(await migrateUp(pool)).toHaveLength(15);
    expect(await latest()).toBe("0033_marketplace");
    expect(await catalog()).toEqual(before);
  }, 180_000);
});
