/**
 * Line join: the database state machine (migration 0024, Y7) is the yield domain's (Y1, `@metafarm/domain/yield`).
 * Checked from the SQL itself. A difference means one side changed without the other.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { YIELD_STORE_ERROR_CODES } from "./repositories/yield";
import { EMPTY_CARRY_LEDGER, canonicalCarryLedger, YIELD_CLOSE_REASONS, YIELD_CYCLE_STATES, YIELD_FUTURE_STATES, YIELD_PRE_PUBLICATION_STATES, YIELD_TERMINAL_STATES, YIELD_TRANSITIONS } from "@metafarm/domain/yield";

const here = path.dirname(fileURLToPath(import.meta.url));
const up = readFileSync(path.resolve(here, "../migrations/0024_yield_core.up.sql"), "utf8").replace(/--[^\n]*/g, "");
const list = (re: RegExp) => [...re.exec(up)![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);

describe("migration 0024 and the Y1 cycle model agree", () => {
  it("allows exactly Y1's current-phase transitions, each under Y1's command", () => {
    const body = /CREATE FUNCTION yield_cycle_command[\s\S]*?\$\$([\s\S]*?)\$\$;/.exec(up)![1]!;
    const sql = [...body.matchAll(/\('([a-z_]+)', '([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}:${m[3]}`).sort();
    // `dismiss` returns to the prior state; in the current phase only `published` can be disputed.
    const domain = YIELD_TRANSITIONS.filter((t) => !t.future).map((t) => `${t.from}>${t.to === "previous" ? "published" : t.to}:${t.command}`).sort();
    expect(sql).toEqual(domain);
  });

  it("knows the same states and close reasons, and never enters a future state", () => {
    expect(list(/status\s+text NOT NULL DEFAULT 'draft' CHECK \(status IN \(([\s\S]*?)\)\)/)).toEqual([...YIELD_CYCLE_STATES]);
    expect(list(/close_reason\s+text CHECK \(close_reason IN \(([^)]*)\)\)/)).toEqual([...YIELD_CLOSE_REASONS]);
    expect(list(/CONSTRAINT yield_cycles_no_future_phase CHECK \(status NOT IN \(([^)]*)\)\)/)).toEqual([...YIELD_FUTURE_STATES]);
    // cancel and expire are allowed from exactly Y1's pre-publication states.
    const table = /CREATE FUNCTION yield_cycle_command[\s\S]*?\$\$([\s\S]*?)\$\$;/.exec(up)![1]!;
    const from = (cmd: string) => [...table.matchAll(new RegExp(`\\('([a-z_]+)', '[a-z_]+', '${cmd}'\\)`, "g"))].map((m) => m[1]).sort();
    expect(from("cancel")).toEqual([...YIELD_PRE_PUBLICATION_STATES].sort());
    expect(from("expire")).toEqual([...YIELD_PRE_PUBLICATION_STATES].sort());
    // No transition leaves a terminal state.
    for (const t of YIELD_TERMINAL_STATES) expect(table).not.toMatch(new RegExp(`\\('${t}', '[a-z_]+', '[a-z_]+'\\)`));
  });

  it("enforces Y1's four-eyes rule: approve is refused to the preparer and the creator", () => {
    expect(YIELD_TRANSITIONS.find((t) => t.command === "approve")!.actor).toBe("reviewer");
    expect(up).toMatch(/NEW\.status_changed_by IS NOT DISTINCT FROM OLD\.prepared_by OR NEW\.status_changed_by IS NOT DISTINCT FROM OLD\.created_by/);
  });
});

describe("migrations 0026–0028 (line join, G2, G3) stay in step with the code", () => {
  const sql = (n: string) => readFileSync(path.resolve(here, `../migrations/${n}`), "utf8").replace(/--[^\n]*/g, "");
  const files = ["0026_yield_simulation_dossiers.up.sql", "0027_yield_frozen_artifacts.up.sql", "0028_yield_carry_ledgers.up.sql"];

  it("every refusal carries a stable code the repository knows", () => {
    for (const f of files)
      for (const r of sql(f).matchAll(/RAISE EXCEPTION[^;]*;/g)) {
        const hint = /HINT = 'yield:([a-z_]+)'/.exec(r[0]);
        expect(hint, `${f}: ${r[0]}`).not.toBeNull();
        expect(YIELD_STORE_ERROR_CODES as readonly string[]).toContain(hint![1]);
      }
  });

  it("the database's genesis carry ledger is the domain's canonical empty ledger", () => {
    expect(sql("0028_yield_carry_ledgers.up.sql")).toContain(`ledger_in = '${canonicalCarryLedger(EMPTY_CARRY_LEDGER)}'`);
  });

  it("content addresses are checked by the database itself, and nothing is updatable or deletable", () => {
    expect(sql(files[1]!)).toContain("CONSTRAINT yield_frozen_artifacts_content_hash CHECK (artifact_sha256 = encode(sha256(convert_to(body, 'UTF8')), 'hex'))");
    expect(sql(files[2]!)).toContain("CONSTRAINT yield_carry_ledgers_out_hash CHECK (ledger_out_sha256 = encode(sha256(convert_to(ledger_out, 'UTF8')), 'hex'))");
    for (const f of files) {
      for (const g of sql(f).matchAll(/GRANT ([A-Z, ]+) ON (?!SEQUENCE|FUNCTION)/g)) expect(g[1], f).not.toMatch(/UPDATE|DELETE|TRUNCATE/);
      expect(sql(f), f).toMatch(/append_only\(\)/);
      expect(sql(f), f).toContain("FORCE ROW LEVEL SECURITY");
    }
  });

  it("calculate requires the persisted artifact and the carry record, by trigger, after the 0024 guard", () => {
    // Triggers of one event fire in name order: the 0024 guard first, then these.
    const names = ["yield_cycles_guard", "yield_cycles_require_frozen_artifact", "yield_cycles_require_zcarry"];
    expect([...names].sort()).toEqual(names);
    expect(sql(files[1]!)).toContain("CREATE TRIGGER yield_cycles_require_frozen_artifact BEFORE UPDATE ON yield_cycles");
    expect(sql(files[2]!)).toContain("CREATE TRIGGER yield_cycles_require_zcarry BEFORE UPDATE ON yield_cycles");
  });
});
