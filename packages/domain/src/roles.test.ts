/** D-28 (plan §7.3): who holds the yield permissions. */
import { describe, expect, it } from "vitest";
import { ROLES, ROLE_PERMISSIONS, YIELD_PERMISSIONS } from "./roles";

const yieldOf = (r: (typeof ROLES)[number]) => YIELD_PERMISSIONS.filter((p) => ROLE_PERMISSIONS[r].has(p));

describe("yield permissions (D-28)", () => {
  it("gives each role exactly its yield duties", () => {
    expect(Object.fromEntries(ROLES.map((r) => [r, yieldOf(r)]))).toEqual({
      owner: ["yield:read", "yield:prepare", "yield:review", "yield:attest", "yield:approve"],
      admin: ["yield:read", "yield:prepare", "yield:approve"],
      manager: ["yield:read", "yield:prepare"],
      verifier: ["yield:read", "yield:review", "yield:attest"],
      worker: [],
      viewer: [],
    });
  });

  it("never lets the auditor role prepare or approve, and never gives it the audit trail", () => {
    for (const p of ["yield:prepare", "yield:approve", "audit:read"] as const) expect(ROLE_PERMISSIONS.verifier.has(p)).toBe(false);
  });
});
