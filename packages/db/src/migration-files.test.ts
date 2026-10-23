/**
 * Migration files: ordering and pairing (no database). The migrator applies every pending `.up.sql` in sorted order,
 * so numbering must be contiguous and unique, and every migration needs a reviewed rollback.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const files = readdirSync(dir).sort();
const ups = files.filter((f) => f.endsWith(".up.sql"));

describe("migration files", () => {
  it("are only NNNN_name.up.sql / NNNN_name.down.sql pairs", () => {
    for (const f of files) expect(f, f).toMatch(/^\d{4}_[a-z0-9_]+\.(up|down)\.sql$/);
    for (const up of ups) expect(files, up).toContain(up.replace(/\.up\.sql$/, ".down.sql"));
    for (const down of files.filter((f) => f.endsWith(".down.sql"))) expect(files, down).toContain(down.replace(/\.down\.sql$/, ".up.sql"));
  });

  it("are numbered contiguously from 0001 with no duplicates", () => {
    const numbers = ups.map((f) => Number(f.slice(0, 4)));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it("include the yield line through 0029, then the realtime outbox, integrations, retention horizons and the marketplace, in their reviewed order", () => {
    const names = ups.map((f) => f.replace(/\.up\.sql$/, ""));
    expect(names.slice(18, 33)).toEqual([
      "0019_twin_foundation",
      "0020_ownership_index",
      "0021_idempotency",
      "0022_player_wallets",
      "0023_ownership_source_identities",
      "0024_yield_core",
      "0025_party_account_links",
      "0026_yield_simulation_dossiers",
      "0027_yield_frozen_artifacts",
      "0028_yield_carry_ledgers",
      "0029_yield_claim_intent_batches",
      "0030_realtime_events",
      "0031_integrations",
      "0032_realtime_retention_horizons",
      "0033_marketplace",
    ]);
  });

  it("never reference a signer, mainnet switch or TRON in the yield line", () => {
    for (const f of ups.filter((x) => Number(x.slice(0, 4)) >= 24)) {
      const sql = readFileSync(path.join(dir, f), "utf8").toLowerCase();
      for (const word of ["signer", "private_key", "tron", "mainnet_enabled"]) expect(sql.includes(word), `${f}: ${word}`).toBe(false);
    }
  });
});
