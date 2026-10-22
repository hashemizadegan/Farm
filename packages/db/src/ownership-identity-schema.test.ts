/**
 * Migration 0023 (Y0, D-16 option A): the verified cluster identity table and its binding to ownership events
 * and cursors. Checked from the SQL itself (no database needed); behaviour is covered by the worker's
 * integration tests.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(here, rel), "utf8");
const up = read("../migrations/0023_ownership_source_identities.up.sql");
const down = read("../migrations/0023_ownership_source_identities.down.sql");
const code = (sql: string) => sql.replace(/--[^\n]*/g, ""); // statements only, without comments

describe("migration 0023: ownership source identities", () => {
  it("stores exactly the network, genesis hash, endpoint scheme and host, and who verified it when", () => {
    const body = /CREATE TABLE ownership_source_identities \(([\s\S]*?)\n\);/.exec(code(up))![1]!;
    const columns = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[a-z_]+\s/.test(l) && !/^(CONSTRAINT|UNIQUE|PRIMARY|CHECK)\b/i.test(l))
      .map((l) => l.split(/\s+/)[0]);
    expect(columns).toEqual(["id", "network", "genesis_hash", "endpoint_scheme", "endpoint_host", "verified_at", "verified_by", "last_verified_at"]);
  });

  it("has no column that could hold credentials, a URL, a path or a query string", () => {
    for (const forbidden of ["url", "path", "query", "token", "key", "secret", "password", "credential", "user", "auth"])
      expect(code(up).match(new RegExp(`\\b\\w*${forbidden}\\w*\\s+(text|varchar|jsonb|bytea)`, "i")), forbidden).toBeNull();
    // The host check admits no '/', '?', '#', '@' or whitespace (lowercase host, optional port).
    expect(code(up)).toContain("endpoint_host ~ '^[a-z0-9.\\-]{1,253}(:[0-9]{1,5})?$'");
    expect(code(up)).toContain("endpoint_scheme IN ('https', 'http')");
  });

  it("binds each network label to the genesis hash the chain package verifies against", () => {
    const chain = readFileSync(path.resolve(here, "../../chain/src/solana/cluster.ts"), "utf8");
    for (const network of ["solana-devnet", "solana-mainnet"]) {
      const hash = new RegExp(`"${network}": "([1-9A-HJ-NP-Za-km-z]{32,44})"`).exec(chain)![1]!;
      expect(code(up)).toContain(`network = '${network}'${network === "solana-devnet" ? "  " : " "}AND genesis_hash = '${hash}'`);
    }
  });

  it("links events and cursors to an identity of their own network, required for RPC rows and refused for fixtures", () => {
    for (const table of ["chain_ownership_events", "chain_ownership_cursors"]) {
      expect(code(up)).toContain(`ALTER TABLE ${table} ADD COLUMN source_identity_id bigint;`);
      expect(code(up)).toContain(`ADD CONSTRAINT ${table}_identity_fkey FOREIGN KEY (source_identity_id, network) REFERENCES ownership_source_identities (id, network);`);
      expect(code(up)).toContain(`ADD CONSTRAINT ${table}_identity_check\n  CHECK ((source = 'rpc' AND source_identity_id IS NOT NULL) OR (source = 'fixture' AND source_identity_id IS NULL)) NOT VALID;`);
    }
    // The application role may only read identities.
    expect(code(up)).toContain("GRANT SELECT ON ownership_source_identities TO metafarm_app;");
    expect(code(up)).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)/i);
  });

  it("the down migration removes everything the up migration adds", () => {
    for (const name of ["chain_ownership_events_source_identity_idx", "chain_ownership_cursors_identity_check", "chain_ownership_events_identity_check", "chain_ownership_cursors_identity_fkey", "chain_ownership_events_identity_fkey"])
      expect(code(down), name).toContain(name);
    expect(code(down)).toContain("ALTER TABLE chain_ownership_events DROP COLUMN source_identity_id;");
    expect(code(down)).toContain("ALTER TABLE chain_ownership_cursors DROP COLUMN source_identity_id;");
    expect(code(down)).toContain("DROP TABLE ownership_source_identities;");
  });
});
