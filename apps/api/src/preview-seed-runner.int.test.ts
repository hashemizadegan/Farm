/**
 * The preview seed runner end to end on a database of its own (created and dropped here): refusals, a full seed of
 * a fresh migrated database (demo workspace, yield cycles, farm operations journey), idempotency, and refusal once
 * the database holds another workspace.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrateUp, type Pool } from "@metafarm/db";
import { DEV_SECRET } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const DB = `preview_seed_${process.pid}`;
const apiDir = fileURLToPath(new URL("..", import.meta.url));

d("preview seed runner", () => {
  let admin: Pool;
  let previewUrl: string;
  let preview: Pool;

  const run = (env: Record<string, string | undefined>) => {
    const childEnv: Record<string, string | undefined> = { ...process.env, DATABASE_URL: previewUrl, DEV_AUTH_SECRET: DEV_SECRET, INTEGRATION_SECRET_KEY: "preview-seed-test-integration-key-0123456789", ...env };
    for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/scripts/preview-seed-runner.ts"], { cwd: apiDir, env: childEnv as NodeJS.ProcessEnv, encoding: "utf8", timeout: 180_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  beforeAll(async () => {
    admin = createPool({ connectionString: url!, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
    const u = new URL(url!);
    u.pathname = `/${DB}`;
    previewUrl = u.toString();
    preview = createPool({ connectionString: previewUrl, max: 2 });
  }, 60_000);

  afterAll(async () => {
    await preview?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin?.end();
  });

  it("refuses deployed or unknown environments before connecting", () => {
    for (const APP_ENV of ["production", "staging", undefined]) {
      const r = run({ APP_ENV, DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none" });
      expect(r.code, String(APP_ENV)).toBe(1);
      expect(r.out).toContain("refused: APP_ENV must be development or test");
    }
  });

  it("refuses an unmigrated database", () => {
    const r = run({ APP_ENV: "test" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("migrations must be applied through 0033");
  });

  it("seeds a fresh migrated database, and a second run changes nothing", async () => {
    await migrateUp(preview);
    const first = run({ APP_ENV: "test", MARKETPLACE_ENABLED: "true" });
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain("[preview-seed] done");
    const cycles = async () =>
      (await preview.query<{ status: string }>(`SELECT c.status FROM yield_cycles c JOIN business_assets a ON a.id = c.business_asset_id WHERE a.name = 'Yield simulation shares' ORDER BY c.period_start`)).rows.map((r) => r.status);
    expect(await cycles()).toEqual(["published", "published", "under_review"]);
    expect((await preview.query(`SELECT count(*)::int AS n FROM yield_claim_intent_batches`)).rows[0].n).toBe(2);
    // The farm operations journey: sensors in every freshness state, and observations from all three sources.
    const sensors = (
      await preview.query<{ name: string; status: string; seen: boolean; stale: boolean }>(
        `SELECT s.name, s.status, s.last_seen_at IS NOT NULL AS seen, s.last_seen_at < now() - make_interval(mins => s.silent_after_minutes) AS stale
           FROM sensors s JOIN farms f ON f.id = s.farm_id WHERE f.name = 'North orchard (simulation)' ORDER BY s.name`,
      )
    ).rows;
    expect(sensors).toEqual([
      { name: "Rain gauge (simulation)", status: "disabled", seen: false, stale: null },
      { name: "Soil probe A (simulation)", status: "active", seen: true, stale: false },
      { name: "Soil probe B (simulation)", status: "active", seen: true, stale: true },
      { name: "Weather mast (simulation)", status: "active", seen: false, stale: null },
    ]);
    const sources = (await preview.query<{ provenance_label: string; n: number }>(`SELECT o.provenance_label, count(*)::int AS n FROM observations o JOIN farms f ON f.id = o.farm_id WHERE f.name = 'North orchard (simulation)' GROUP BY 1 ORDER BY 1`)).rows;
    expect(sources).toEqual([
      { provenance_label: "provider-observation", n: 4 },
      { provenance_label: "sensor-reported", n: 1 },
      { provenance_label: "user-entered", n: 1 },
    ]);
    expect((await preview.query(`SELECT name, status FROM integrations`)).rows).toEqual([{ name: "Simulated field feed", status: "active" }]);
    expect(first.out).not.toMatch(/mfi_/);
    // The marketplace journey: four listings by the demo workspace, one example order delivered, nothing transferred.
    const listings = (await preview.query<{ kind: string; status: string; tenant: string }>(`SELECT l.kind, l.status, t.slug AS tenant FROM market_listings l JOIN tenants t ON t.id = l.tenant_id ORDER BY l.kind, l.title`)).rows;
    expect(listings).toEqual([
      { kind: "produce", status: "active", tenant: "demo" },
      { kind: "produce", status: "active", tenant: "demo" },
      { kind: "registered_asset", status: "active", tenant: "demo" },
      { kind: "registered_asset", status: "active", tenant: "demo" },
    ]);
    expect((await preview.query(`SELECT status, simulated FROM market_orders`)).rows).toEqual([{ status: "delivered", simulated: true }]);
    expect((await preview.query(`SELECT count(*)::int AS n FROM market_asset_control`)).rows[0].n).toBe(0);
    const second = run({ APP_ENV: "test", MARKETPLACE_ENABLED: "true" });
    expect(second.code, second.out).toBe(0);
    expect(second.out).toContain("already seeded");
    expect(await cycles()).toEqual(["published", "published", "under_review"]);
  }, 300_000);

  it("refuses once the database holds a real sign-in, or a workspace the development seed did not create", async () => {
    await preview.query(`INSERT INTO users (oidc_issuer, oidc_subject) VALUES ('https://idp.example', 'real-person')`);
    const user = run({ APP_ENV: "test" });
    expect(user.code).toBe(1);
    expect(user.out).toContain("from a real identity provider");
    await preview.query(`DELETE FROM users WHERE oidc_issuer = 'https://idp.example'`);
    await preview.query(`INSERT INTO tenants (slug, name) VALUES ('acme-real', 'A real workspace')`);
    const tenant = run({ APP_ENV: "test" });
    expect(tenant.code).toBe(1);
    expect(tenant.out).toContain("not a fresh, isolated preview database");
    expect(`${user.out}${tenant.out}`).not.toContain(DEV_SECRET);
  });
});
