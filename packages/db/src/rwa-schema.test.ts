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
} from "@metafarm/domain";

const sql = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations/0011_rwa_rails.up.sql"), "utf8");

/** The values of `CHECK (<column> IN (...))` inside one CREATE TABLE. */
function checkList(table: string, column: string): string[] {
  const body = sql.slice(sql.indexOf(`CREATE TABLE ${table} (`));
  const m = new RegExp(`\\b${column}\\s+text NOT NULL[^,]*?CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(body.slice(0, body.indexOf("\n);")));
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
  ] as const)("%s.%s", (table, column, values) => {
    expect(checkList(table, column)).toEqual([...values]);
  });

  it("guards exactly the domain's lifecycle transitions", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION chain_operation_transition_allowed"), sql.indexOf("$$;", sql.indexOf("FUNCTION chain_operation_transition_allowed")));
    const pairs = [...fn.matchAll(/\('(\w+)', '(\w+)'\)/g)].map((m) => [m[1], m[2]]);
    expect(pairs).toEqual(TRANSITIONS.map(([a, b]) => [a, b]));
  });

  it("puts every new table behind row-level security", () => {
    const tables = [...sql.matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1]);
    const rls = /ARRAY\[([^\]]+)\]/.exec(sql.slice(sql.indexOf("Row-level security")))![1]!;
    for (const t of tables) expect(rls).toContain(`'${t}'`);
  });
});
