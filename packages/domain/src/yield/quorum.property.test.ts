import { describe, expect, it } from "vitest";
import type { Attestation, AttestationMethodList } from "./attestation";
import { type AttestationQuorum, type QuorumResult, evaluateAttestationQuorum } from "./quorum";

/**
 * Exhaustive and adversarial checks of quorum evaluation against an independent brute-force oracle.
 * Every graph of up to 3 roles × 3 attesters (each attester eligible or not for each role), with every
 * minimum in {1, 2}, is evaluated in both modes, in several input orders.
 */

const H1 = "ed8d97c08bf3add20118c75a4e92eb49af62ed9b602a6e60b3e5e87e440f5726";
const SUBJECTS = [H1];
const sim = { simulation: true, assetClass: "crop" };
const methods: AttestationMethodList = { id: "m", version: 1, status: "simulation", methods: ["recorded"], keyAlgorithms: [] };
const att = (attester: string, role: string): Attestation => ({
  attester,
  role,
  statement: "checked",
  subjectHashes: SUBJECTS,
  issuedAt: "2026-10-02T09:00:00Z",
  revokes: null,
  proof: { method: "recorded", auditEventId: `audit-${attester}-${role}` },
});
const quorum = (rules: AttestationQuorum["rules"], several: boolean): AttestationQuorum => ({ id: "q", version: 1, status: "simulation", assetClass: "crop", rules, attesterMayFillSeveralRoles: several });
const evaluate = (q: AttestationQuorum, atts: Attestation[]) => evaluateAttestationQuorum(sim, q, methods, SUBJECTS, atts);

/** Independent oracle: can every slot be filled by a distinct attester? Plain backtracking search. */
function oracleExclusive(eligible: string[][], minimums: number[]): boolean {
  const slots = minimums.flatMap((m, role) => Array.from({ length: m }, () => role));
  const used = new Set<string>();
  const fill = (i: number): boolean => {
    if (i === slots.length) return true;
    for (const a of eligible[slots[i]!]!) {
      if (used.has(a)) continue;
      used.add(a);
      if (fill(i + 1)) return true;
      used.delete(a);
    }
    return false;
  };
  return fill(0);
}

let seed = 0xc0ffee;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function shuffle<T>(xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function checkInvariants(r: QuorumResult, eligible: string[][], minimums: number[], several: boolean): void {
  r.roles.forEach((role, i) => {
    expect(role.eligible).toEqual([...eligible[i]!].sort());
    expect(role.required).toBe(minimums[i]);
    for (const a of role.counted) expect(role.eligible).toContain(a);
    expect([...role.counted].sort()).toEqual(role.counted);
  });
  if (several) {
    r.roles.forEach((role) => expect(role.counted).toEqual(role.eligible));
  } else {
    const all = r.roles.flatMap((x) => x.counted);
    expect(new Set(all).size).toBe(all.length); // no attester counted twice
    if (r.met) r.roles.forEach((role) => expect(role.counted.length).toBe(role.required));
  }
  expect(r.met).toBe(r.roles.every((x) => x.met));
}

describe("quorum: exhaustive small graphs against a brute-force oracle", () => {
  it("agrees with the oracle and is order-independent for every graph up to 3 roles × 3 attesters", async () => {
    const attesters = ["a", "b", "c"];
    let cases = 0;
    for (let nRoles = 1; nRoles <= 3; nRoles++)
      for (let mask = 0; mask < 1 << (nRoles * 3); mask++)
        for (let mins = 0; mins < 1 << nRoles; mins++) {
          const roles = Array.from({ length: nRoles }, (_, i) => `role-${i}`);
          const minimums = roles.map((_, i) => ((mins >> i) & 1) + 1);
          const eligible = roles.map((_, i) => attesters.filter((_, j) => (mask >> (i * 3 + j)) & 1));
          const atts = roles.flatMap((role, i) => eligible[i]!.map((a) => att(a, role)));
          const rules = roles.map((role, i) => ({ role, minimumAttesters: minimums[i]! }));

          const exclusive = await evaluate(quorum(rules, false), atts);
          expect(exclusive.met, `mask ${mask} mins ${minimums}`).toBe(oracleExclusive(eligible, minimums));
          checkInvariants(exclusive, eligible, minimums, false);
          // Input order never changes the result, and rule order never changes whether it is met.
          expect(await evaluate(quorum(rules, false), [...atts].reverse())).toEqual(exclusive);
          expect(await evaluate(quorum(rules, false), shuffle(atts))).toEqual(exclusive);
          expect((await evaluate(quorum([...rules].reverse(), false), atts)).met).toBe(exclusive.met);

          const several = await evaluate(quorum(rules, true), atts);
          expect(several.met).toBe(eligible.every((e, i) => e.length >= minimums[i]!));
          checkInvariants(several, eligible, minimums, true);
          expect(await evaluate(quorum(rules, true), shuffle(atts))).toEqual(several);
          cases++;
        }
    expect(cases).toBe(8 * 2 + 64 * 4 + 512 * 8); // 4,368 graphs
  }, 60_000);
});

describe("quorum: adversarial topologies", () => {
  it("finds the only assignment through a 40-role augmenting chain", async () => {
    // Role i accepts attesters i and i+1; the last role accepts only attester 0. Trying attesters in sorted
    // order gives role 0 attester 0, so the last role can only be filled by reassigning along the chain.
    const n = 40;
    const name = (i: number) => `a${String(i).padStart(2, "0")}`;
    const rules = Array.from({ length: n }, (_, i) => ({ role: `r${i}`, minimumAttesters: 1 }));
    const atts = rules.flatMap((rule, i) => (i < n - 1 ? [att(name(i), rule.role), att(name(i + 1), rule.role)] : [att(name(0), rule.role)]));
    const r = await evaluate(quorum(rules, false), atts);
    expect(r.met).toBe(true);
    expect(r.roles[n - 1]!.counted).toEqual([name(0)]);
    expect(r.roles[0]!.counted).toEqual([name(1)]);
    expect(await evaluate(quorum(rules, false), shuffle(atts))).toEqual(r);
  });

  it("detects a Hall violation: three roles that only two attesters can fill", async () => {
    const rules = ["r0", "r1", "r2"].map((role) => ({ role, minimumAttesters: 1 }));
    const atts = rules.flatMap((rule) => [att("x", rule.role), att("y", rule.role)]);
    expect((await evaluate(quorum(rules, false), atts)).met).toBe(false);
    expect((await evaluate(quorum(rules, true), atts)).met).toBe(true);
  });

  it("fills a complete 60 × 60 assignment, and fails it when one attester is missing", async () => {
    const n = 60;
    const rules = Array.from({ length: n }, (_, i) => ({ role: `r${i}`, minimumAttesters: 1 }));
    const names = Array.from({ length: n }, (_, i) => `a${String(i).padStart(2, "0")}`);
    const atts = rules.flatMap((rule) => names.map((a) => att(a, rule.role)));
    const full = await evaluate(quorum(rules, false), atts);
    expect(full.met).toBe(true);
    expect(new Set(full.roles.flatMap((x) => x.counted)).size).toBe(n);
    expect((await evaluate(quorum(rules, false), atts.filter((a) => a.attester !== "a59"))).met).toBe(false);
  });

  it("counts repeated attestations by one attester once, and attester ids by code units (no normalisation)", async () => {
    const rules = [{ role: "auditor", minimumAttesters: 2 }];
    expect((await evaluate(quorum(rules, false), [att("x", "auditor"), att("x", "auditor"), att("x", "auditor")])).met).toBe(false);
    // "é" precomposed and decomposed are different identifiers here; identity canonicalisation is the caller's.
    const r = await evaluate(quorum(rules, false), [att("é", "auditor"), att("é", "auditor")]);
    expect(r.met).toBe(true);
  });

  it("does not count attestations in roles the quorum does not name", async () => {
    const r = await evaluate(quorum([{ role: "auditor", minimumAttesters: 1 }], false), [att("x", "Auditor"), att("y", "auditor ")].filter((a) => a.role.trim() === a.role));
    expect(r.met).toBe(false);
    expect(r.roles[0]!.eligible).toEqual([]);
  });
});
