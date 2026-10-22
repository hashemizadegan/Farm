/**
 * Line join: the database state machine (migration 0024, Y7) is the yield domain's (Y1, `@metafarm/domain/yield`).
 * Checked from the SQL itself. A difference means one side changed without the other.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { YIELD_CLOSE_REASONS, YIELD_CYCLE_STATES, YIELD_FUTURE_STATES, YIELD_PRE_PUBLICATION_STATES, YIELD_TERMINAL_STATES, YIELD_TRANSITIONS } from "@metafarm/domain/yield";

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
