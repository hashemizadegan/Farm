/**
 * Migration 0024 (Y7): checked from the SQL itself (no database needed). Behaviour is covered by the
 * PostgreSQL integration tests (yield-schema.int.test.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { YIELD_STORE_ERROR_CODES, toYieldStoreError, YieldStoreError } from "./repositories/yield";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(here, rel), "utf8");
const up = read("../migrations/0024_yield_core.up.sql");
const down = read("../migrations/0024_yield_core.down.sql");
const code = (sql: string) => sql.replace(/--[^\n]*/g, "");
const TABLES = ["yield_cycles", "yield_cycle_transitions", "yield_artifact_sets", "yield_ownership_snapshots", "yield_allocations", "yield_attestations", "yield_evidence", "yield_inputs"];

/** Plan §2.1 (revision 4), current phase: the same pairs as YIELD_TRANSITIONS of the yield domain (Y1), without the future ones. */
const PLAN_TRANSITIONS = [
  ["draft", "inputs_locked", "lock"],
  ["inputs_locked", "draft", "unlock"],
  ["calculated", "inputs_locked", "unlock"],
  ["inputs_locked", "calculated", "calculate"],
  ["calculated", "under_review", "submit"],
  ["under_review", "inputs_locked", "reject"],
  ["under_review", "approved", "approve"],
  ["approved", "published", "publish"],
  ...["draft", "inputs_locked", "calculated", "under_review", "approved"].flatMap((f) => [
    [f, "cancelled", "cancel"],
    [f, "abandoned", "expire"],
  ]),
  ["published", "closed", "close"],
  ["published", "disputed", "dispute"],
  ["disputed", "published", "dismiss"],
  ["published", "superseded", "supersede"],
  ["disputed", "superseded", "supersede"],
];

describe("migration 0024: yield core schema (Y7)", () => {
  it("allows exactly the current-phase transitions of plan §2.1, and none into the future phases", () => {
    const body = /CREATE FUNCTION yield_cycle_command[\s\S]*?\$\$([\s\S]*?)\$\$;/.exec(code(up))![1]!;
    const pairs = [...body.matchAll(/\('([a-z_]+)', '([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => [m[1], m[2], m[3]]);
    const key = (p: (string | undefined)[]) => p.join(">");
    expect(pairs.map(key).sort()).toEqual(PLAN_TRANSITIONS.map(key).sort());
    expect(pairs.some((p) => p[1] === "funded" || p[1] === "distributing")).toBe(false);
    expect(code(up)).toContain("CONSTRAINT yield_cycles_no_future_phase CHECK (status NOT IN ('funded', 'distributing'))");
  });

  it("fails closed: simulation by default, real cycles stop at inputs_locked, evidence simulation-only until D-24", () => {
    expect(code(up)).toMatch(/simulation\s+boolean NOT NULL DEFAULT true,/);
    expect(code(up)).toContain("CONSTRAINT yield_cycles_real_gate CHECK (simulation OR status IN ('draft', 'inputs_locked', 'cancelled', 'abandoned'))");
    expect(code(up)).toContain("CONSTRAINT yield_evidence_simulation_only CHECK (simulation)");
  });

  it("D-17 layer 2: fixture snapshots only in simulation cycles; RPC snapshots bound to a verified identity of their network", () => {
    expect(code(up)).toMatch(/IF NEW\.source_kind = 'fixture' AND NOT c\.simulation THEN\s+RAISE EXCEPTION 'fixture ownership cannot be used by a non-simulation cycle'/);
    expect(code(up)).toContain("FOREIGN KEY (source_identity_id, network) REFERENCES ownership_source_identities(id, network)");
    expect(code(up)).toContain("CONSTRAINT yield_ownership_snapshots_source_identity CHECK ((source_kind = 'rpc') = (source_identity_id IS NOT NULL))");
  });

  it("forces row-level security on every table and grants no DELETE, no UPDATE on history or sets", () => {
    for (const t of TABLES) expect(code(up)).toContain(`'${t}'`);
    expect(code(up)).toContain("FORCE ROW LEVEL SECURITY");
    const grants = [...code(up).matchAll(/GRANT ([A-Z, ]+) ON ([a-z_, ]+) TO metafarm_app/g)];
    for (const g of grants) expect(g[1]).not.toMatch(/DELETE|TRUNCATE/);
    const updatable = grants.filter((g) => g[1]!.includes("UPDATE")).flatMap((g) => g[2]!.split(",").map((s) => s.trim()));
    expect(updatable).toEqual(["yield_cycles"]);
  });

  it("every refusal carries a stable code the repository knows", () => {
    const raises = [...code(up).matchAll(/RAISE EXCEPTION[^;]*;/g)].map((m) => m[0]);
    expect(raises.length).toBeGreaterThan(30);
    for (const r of raises) {
      const hint = /HINT = 'yield:([a-z_]+)'/.exec(r);
      expect(hint, r).not.toBeNull();
      expect(YIELD_STORE_ERROR_CODES as readonly string[]).toContain(hint![1]);
    }
  });

  it("maps database errors to stable codes and leaves other errors alone", () => {
    const e = (x: object) => toYieldStoreError(Object.assign(new Error("m"), x)) as YieldStoreError;
    expect(e({ code: "23514", hint: "yield:four_eyes" }).code).toBe("four_eyes");
    expect(e({ code: "23514", constraint: "yield_cycles_real_gate" }).code).toBe("real_gate");
    expect(e({ code: "23514", constraint: "yield_evidence_simulation_only" }).code).toBe("evidence_retention_unapproved");
    expect(e({ code: "23505" }).code).toBe("duplicate");
    expect(e({ code: "23503" }).code).toBe("not_found");
    expect(e({ code: "42501" }).code).toBe("forbidden");
    expect(e({ code: "23514", hint: "yield:not_a_code" }).code).toBe("invalid_input");
    const other = new Error("network");
    expect(toYieldStoreError(other)).toBe(other);
    expect(toYieldStoreError(Object.assign(new Error("x"), { code: "57014" }))).not.toBeInstanceOf(YieldStoreError);
  });

  it("is reversible without touching other tables", () => {
    for (const t of TABLES) expect(code(down)).toContain(`DROP TABLE IF EXISTS ${t};`);
    for (const f of [...code(up).matchAll(/CREATE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1])) expect(code(down)).toContain(`DROP FUNCTION IF EXISTS ${f}(`);
    expect(code(down)).not.toMatch(/DROP TABLE IF EXISTS (?!yield_)/);
    expect(code(up)).not.toMatch(/ALTER TABLE (?!%I)(?!yield_)/);
  });
});
