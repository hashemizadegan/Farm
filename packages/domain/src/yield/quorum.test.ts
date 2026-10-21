import { describe, expect, it } from "vitest";
import type { Attestation, AttestationMethodList } from "./attestation";
import { type AttestationQuorum, attestationQuorumProblems, evaluateAttestationQuorum } from "./quorum";
import { YieldRecordError } from "./records";

const H1 = "ed8d97c08bf3add20118c75a4e92eb49af62ed9b602a6e60b3e5e87e440f5726";
const H2 = "5436e7948ad1df5d02e9d2e310ab6cc9b60f3055d093d69ae1fb32a525738982";
const sim = { simulation: true, assetClass: "crop" };
const methods: AttestationMethodList = { id: "m", version: 1, status: "simulation", methods: ["recorded"], keyAlgorithms: [] };

const att = (attester: string, role: string, subjectHashes = [H1, H2], revokes: string | null = null): Attestation => ({
  attester,
  role,
  statement: "checked",
  subjectHashes,
  issuedAt: "2026-10-02T09:00:00Z",
  revokes,
  proof: { method: "recorded", auditEventId: `audit-${attester}-${role}` },
});
const quorum = (rules: AttestationQuorum["rules"], attesterMayFillSeveralRoles: boolean, patch: Partial<AttestationQuorum> = {}): AttestationQuorum => ({
  id: "q",
  version: 1,
  status: "simulation",
  assetClass: "crop",
  rules,
  attesterMayFillSeveralRoles,
  ...patch,
});
const run = (q: AttestationQuorum, atts: Attestation[], subjects = [H1, H2], cycle = sim) => evaluateAttestationQuorum(cycle, q, methods, subjects, atts);

describe("quorum evaluation", () => {
  it("counts distinct attesters per role that cover every subject hash", async () => {
    const r = await run(quorum([{ role: "auditor", minimumAttesters: 2 }], true), [att("a1", "auditor"), att("a1", "auditor"), att("a2", "auditor"), att("a3", "auditor", [H1])]);
    expect(r.met).toBe(true);
    expect(r.roles[0]).toEqual({ role: "auditor", required: 2, eligible: ["a1", "a2"], counted: ["a1", "a2"], met: true });
    // The same attester twice counts once; a3 does not cover H2.
    expect((await run(quorum([{ role: "auditor", minimumAttesters: 3 }], true), [att("a1", "auditor"), att("a1", "auditor"), att("a2", "auditor"), att("a3", "auditor", [H1])])).met).toBe(false);
  });

  it("lets one attester fill several roles only when the record says so", async () => {
    const atts = [att("x", "auditor"), att("x", "agronomist")];
    const rules = [{ role: "auditor", minimumAttesters: 1 }, { role: "agronomist", minimumAttesters: 1 }];
    expect((await run(quorum(rules, true), atts)).met).toBe(true);
    expect((await run(quorum(rules, false), atts)).met).toBe(false);
  });

  it("finds an assignment where trying attesters in order would not (maximum matching)", async () => {
    // auditor: x or y; agronomist: only x. Giving x to auditor first would leave agronomist unfilled.
    const atts = [att("x", "auditor"), att("y", "auditor"), att("x", "agronomist")];
    const r = await run(quorum([{ role: "auditor", minimumAttesters: 1 }, { role: "agronomist", minimumAttesters: 1 }], false), atts);
    expect(r.met).toBe(true);
    expect(r.roles.map((x) => [x.role, x.counted])).toEqual([
      ["auditor", ["y"]],
      ["agronomist", ["x"]],
    ]);
    // Same answer whatever the input order.
    expect(await run(quorum([{ role: "auditor", minimumAttesters: 1 }, { role: "agronomist", minimumAttesters: 1 }], false), [...atts].reverse())).toEqual(r);
  });

  it("is unmet without allocating when the requirement exceeds the attesters available", async () => {
    const r = await run(quorum([{ role: "auditor", minimumAttesters: Number.MAX_SAFE_INTEGER }], false), [att("a1", "auditor")]);
    expect(r).toEqual({ met: false, roles: [{ role: "auditor", required: Number.MAX_SAFE_INTEGER, eligible: ["a1"], counted: [], met: false }] });
  });

  it("refuses revoking attestations, methods the list does not allow, and records unusable for the cycle", async () => {
    const q = quorum([{ role: "auditor", minimumAttesters: 1 }], true);
    await expect(run(q, [att("a1", "auditor"), att("a1", "auditor", [H1, H2], H1)])).rejects.toThrow(/effective attestations/);
    const doc: Attestation = { ...att("a1", "auditor"), proof: { method: "document_signature", signedDocumentSha256: H1 } };
    await expect(run(q, [doc])).rejects.toThrow(/does not allow document_signature/);
    await expect(run(q, [att("a1", "auditor")], [H1], { simulation: false, assetClass: "crop" })).rejects.toBeInstanceOf(YieldRecordError);
    await expect(run(quorum(q.rules, true, { status: "draft" }), [att("a1", "auditor")])).rejects.toBeInstanceOf(YieldRecordError);
    await expect(run(q, [att("a1", "auditor")], [H1], { simulation: true, assetClass: "equipment" })).rejects.toThrow(/asset class/);
    await expect(run(q, [att("a1", "auditor")], [])).rejects.toThrow(/subject hashes/);
    await expect(run(q, [att("a1", "auditor")], [H1, H1])).rejects.toThrow(/subject hashes/);
  });
});

describe("quorum record", () => {
  it("has no defaults and refuses empty or inconsistent rules", () => {
    expect(attestationQuorumProblems(quorum([{ role: "auditor", minimumAttesters: 1 }], false))).toEqual([]);
    expect(attestationQuorumProblems({})).toHaveLength(6);
    expect(attestationQuorumProblems(quorum([], true))).toEqual(["rules must be a non-empty list (a quorum must require something)"]);
    expect(attestationQuorumProblems(quorum([{ role: "auditor", minimumAttesters: 0 }], true))).toHaveLength(1);
    expect(attestationQuorumProblems(quorum([{ role: "auditor", minimumAttesters: 1.5 }], true))).toHaveLength(1);
    expect(attestationQuorumProblems(quorum([{ role: "auditor", minimumAttesters: 1 }, { role: "auditor", minimumAttesters: 2 }], true))).toEqual(["rules[1].role repeats auditor"]);
    const { attesterMayFillSeveralRoles: _omit, ...withoutChoice } = quorum([{ role: "auditor", minimumAttesters: 1 }], true);
    expect(attestationQuorumProblems(withoutChoice)).toEqual(["attesterMayFillSeveralRoles must be true or false"]);
    expect(attestationQuorumProblems({ ...quorum([{ role: "auditor", minimumAttesters: 1 }], true), weightByRole: true })).toEqual(["quorum has unsupported keys: weightByRole"]);
  });
});
