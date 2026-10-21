/**
 * The alert rules (infra/alerts/metafarm.rules.yml) refer only to metrics the services register, and
 * every rule is complete. Prometheus itself is not available here, so PromQL syntax is not checked.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PLATFORM_METRIC_NAMES } from "@metafarm/observability";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../infra/alerts/metafarm.rules.yml");
type Rule = { alert: string; expr: string; for?: string; labels?: { severity?: string }; annotations?: { summary?: string } };
const doc = parse(readFileSync(file, "utf8")) as { groups: { name: string; rules: Rule[] }[] };
const rules = doc.groups.flatMap((g) => g.rules);

describe("alert rules", () => {
  it("has uniquely named, complete rules", () => {
    expect(rules.length).toBeGreaterThan(0);
    expect(new Set(rules.map((r) => r.alert)).size).toBe(rules.length);
    for (const r of rules) {
      expect(r.alert).toMatch(/^Metafarm[A-Za-z0-9]+$/);
      expect(r.expr.trim().length).toBeGreaterThan(0);
      expect(["page", "ticket"]).toContain(r.labels?.severity);
      expect(r.annotations?.summary?.length ?? 0).toBeGreaterThan(0);
      if (r.for !== undefined) expect(r.for).toMatch(/^\d+[smh]$/);
    }
  });

  it("uses only metrics the services register", () => {
    const known = new Set<string>(PLATFORM_METRIC_NAMES);
    for (const r of rules) {
      for (const m of r.expr.match(/metafarm_[a-z0-9_]+/g) ?? []) {
        const base = m.replace(/_(bucket|sum|count)$/, "");
        expect(known.has(m) || known.has(base), `${r.alert} uses ${m}`).toBe(true);
      }
    }
  });
});
