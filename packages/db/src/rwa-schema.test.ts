/** The RWA migration's constraints must say exactly what the domain model says. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ASSET_KINDS,
  ASSET_STATUSES,
  INTENT_STATUSES,
  ISSUANCE_ACTIONS,
  NETWORKS,
  OPERATION_STATES,
  RAILS,
  RECONCILIATION_KINDS,
  RECONCILIATION_STATUSES,
  REPRESENTATION_STATUSES,
  SETTLEMENT_PURPOSES,
  TRANSITIONS,
  PARTY_KINDS,
  KYC_STATUSES,
  SCREENING_SUBJECTS,
  SCREENING_OUTCOMES,
  ORDER_KINDS,
  ORDER_STATUSES,
  CHAIN_INTENT_TYPES,
  TREE_STATUSES,
  RAIL_NETWORKS,
  DATA_SUBJECT_TYPES,
  OWNERSHIP_EVENT_KINDS,
} from "@metafarm/domain";

const read = (name: string) => readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../migrations/${name}`), "utf8");
const FILES = ["0011_rwa_rails.up.sql", "0012_rwa_orders.up.sql", "0016_cnft_trees.up.sql", "0018_cnft_leaf.up.sql", "0019_twin_foundation.up.sql"];
const sql = FILES.map(read).join("\n");

/**
 * The values of `CHECK (<column> IN (...))`: the latest `ADD CONSTRAINT <table>_<column>_check`
 * that replaced it in a later migration, else the one inside the table's CREATE TABLE.
 */
function checkList(table: string, column: string): string[] {
  const replaced = [...sql.matchAll(new RegExp(`ADD CONSTRAINT ${table}_${column}_check CHECK \\(${column} IN \\(([^)]*)\\)\\)`, "g"))].at(-1);
  const body = sql.slice(sql.indexOf(`CREATE TABLE ${table} (`));
  const m = replaced ?? new RegExp(`\\b${column}\\s+text NOT NULL[^,]*?CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(body.slice(0, body.indexOf("\n);")));
  if (!m) throw new Error(`no CHECK list for ${table}.${column}`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe("RWA schema matches the domain", () => {
  it.each([
    ["business_assets", "kind", ASSET_KINDS],
    ["business_assets", "status", ASSET_STATUSES],
    ["asset_representations", "rail", RAILS],
    ["asset_representations", "network", NETWORKS],
    ["asset_representations", "status", REPRESENTATION_STATUSES],
    ["issuance_intents", "action", ISSUANCE_ACTIONS],
    ["issuance_intents", "status", INTENT_STATUSES],
    ["settlement_intents", "purpose", SETTLEMENT_PURPOSES],
    ["settlement_intents", "status", INTENT_STATUSES],
    ["chain_operations", "network", NETWORKS],
    ["chain_operations", "state", OPERATION_STATES],
    ["reconciliation_cases", "kind", RECONCILIATION_KINDS],
    ["reconciliation_cases", "status", RECONCILIATION_STATUSES],
    ["parties", "kind", PARTY_KINDS],
    ["parties", "kyc_status", KYC_STATUSES],
    ["party_wallets", "network", NETWORKS],
    ["compliance_screenings", "subject", SCREENING_SUBJECTS],
    ["compliance_screenings", "outcome", SCREENING_OUTCOMES],
    ["rwa_orders", "kind", ORDER_KINDS],
    ["rwa_orders", "status", ORDER_STATUSES],
    ["chain_operations", "intent_type", CHAIN_INTENT_TYPES],
    ["merkle_trees", "status", TREE_STATUSES],
    ["merkle_trees", "network", RAIL_NETWORKS.SOLANA_BUBBLEGUM_CNFT],
    ["data_commitments", "subject_type", DATA_SUBJECT_TYPES],
  ] as const)("%s.%s", (table, column, values) => {
    expect(checkList(table, column)).toEqual([...values]);
  });

  it("guards exactly the domain's lifecycle transitions", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION chain_operation_transition_allowed"), sql.indexOf("$$;", sql.indexOf("FUNCTION chain_operation_transition_allowed")));
    const pairs = [...fn.matchAll(/\('(\w+)', '(\w+)'\)/g)].map((m) => [m[1], m[2]]);
    expect(pairs).toEqual(TRANSITIONS.map(([a, b]) => [a, b]));
  });

  it.each(FILES)("%s puts every new table behind row-level security", (file) => {
    const text = read(file);
    const tables = [...text.matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1]);
    if (tables.length === 0) return; // nothing new to protect
    const rls = /ARRAY\[([^\]]+)\]/.exec(text.slice(text.indexOf("ENABLE ROW LEVEL SECURITY") - 400))![1]!;
    for (const t of tables) expect(rls).toContain(`'${t}'`);
  });
});

describe("ownership index schema (0020) matches the domain", () => {
  const text = read("0020_ownership_index.up.sql");
  const list = (table: string, column: string) => {
    const body = text.slice(text.indexOf(`CREATE TABLE ${table} (`));
    const m = new RegExp(`\\b${column}\\s+text NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(body.slice(0, body.indexOf("\n);")));
    if (!m) throw new Error(`no CHECK list for ${table}.${column}`);
    return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  };
  const solanaRails = RAILS.filter((r) => r.startsWith("SOLANA_"));

  it.each(["chain_ownership_events", "chain_ownership_cursors"])("%s covers exactly the Solana rails and networks", (table) => {
    expect(list(table, "rail")).toEqual(solanaRails);
    for (const r of solanaRails) expect(list(table, "network")).toEqual([...RAIL_NETWORKS[r]]);
  });

  it("records exactly the domain's ownership event kinds", () => {
    expect(list("chain_ownership_events", "kind")).toEqual([...OWNERSHIP_EVENT_KINDS]);
  });

  it("lets the application role read and nothing else (public data, written by the system role)", () => {
    const grants = [...text.matchAll(/^GRANT (.+) ON (.+) TO metafarm_app;/gm)].map((m) => [m[1], m[2]]);
    expect(grants).toEqual([["SELECT", "chain_ownership_events, chain_ownership_cursors"]]);
  });
});

describe("idempotency schema (0021)", () => {
  const text = read("0021_idempotency.up.sql");
  it("is tenant-isolated and keyed per tenant, user and key", () => {
    expect(text).toContain("FORCE ROW LEVEL SECURITY");
    expect(text).toContain("tenant_id = app_current_tenant()");
    expect(text).toContain("PRIMARY KEY (tenant_id, user_id, key)");
  });
  it("stores only successful responses", () => {
    expect(text).toContain("status_code BETWEEN 200 AND 299");
  });
});
