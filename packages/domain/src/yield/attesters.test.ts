import { describe, expect, it } from "vitest";
import type { Attestation, AttestationMethodList } from "./attestation";
import {
  type AttesterAuthorizer,
  type AttesterEntity,
  AttesterAuthorizationError,
  attesterRegistryProblems,
  evaluateAuthorizedQuorum,
  registryAuthorizer,
  simulationAttesterRegistry,
} from "./attesters";
import type { AttestationQuorum } from "./quorum";
import { YieldRecordError } from "./records";

// Public keys from published vectors (RFC 8032 tests 1 and 2, RFC 6979 A.2.5). Nothing here signs.
const ED1 = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const ED2 = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
const P256 = "0460fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299";
const H1 = "ed8d97c08bf3add20118c75a4e92eb49af62ed9b602a6e60b3e5e87e440f5726";
const sim = { simulation: true, assetClass: "crop" };

const key = (keyId: string, publicKey: string, patch: Partial<AttesterEntity["keys"][number]> = {}) => ({
  keyId,
  algorithm: publicKey.length === 130 ? ("ecdsa_p256_sha256" as const) : ("ed25519" as const),
  publicKey,
  validFrom: "2026-01-01T00:00:00Z",
  validUntil: null,
  revokedAt: null,
  ...patch,
});
const entity = (entityId: string, keys: AttesterEntity["keys"] = [], patch: Partial<AttesterEntity> = {}): AttesterEntity => ({ entityId, roles: ["auditor"], status: "active", keys, ...patch });
const recorded = (attester: string, role = "auditor"): Attestation => ({ attester, role, statement: "checked", subjectHashes: [H1], issuedAt: "2026-10-02T09:00:00Z", revokes: null, proof: { method: "recorded", auditEventId: `e-${attester}` } });
const signed = (attester: string, publicKey: string, issuedAt = "2026-10-02T09:00:00Z"): Attestation => ({
  ...recorded(attester),
  issuedAt,
  proof: { method: "key_signature", algorithm: publicKey.length === 130 ? "ecdsa_p256_sha256" : "ed25519", publicKey, signature: "00".repeat(64) },
});
const reason = (az: AttesterAuthorizer, a: Attestation, cycle = sim) => {
  const r = az.authorize(cycle, a);
  return r.authorized ? `ok:${r.entityId}:${r.keyId}` : r.reason;
};

describe("Option B registry: authorization", () => {
  const az = registryAuthorizer(simulationAttesterRegistry([entity("auditor-1", [key("k1", ED1)]), entity("auditor-2", [key("k2", ED2), key("k3", P256)], { roles: ["auditor", "agronomist"] })]));

  it("authorizes registered, active entities in roles they hold", () => {
    expect(reason(az, recorded("auditor-1"))).toBe("ok:auditor-1:null");
    expect(reason(az, recorded("auditor-2", "agronomist"))).toBe("ok:auditor-2:null");
    expect(reason(az, signed("auditor-1", ED1))).toBe("ok:auditor-1:k1");
    expect(reason(az, signed("auditor-2", P256))).toBe("ok:auditor-2:k3");
  });

  it("binds keys to entities: an unregistered key, or another entity's key, is refused (the D-23 gap)", () => {
    expect(reason(az, signed("auditor-1", ED2))).toBe("key_registered_to_other_attester");
    expect(reason(az, signed("auditor-2", ED1))).toBe("key_registered_to_other_attester");
    // A self-made key under an invented name is refused twice over: unknown name, unregistered key.
    expect(reason(az, signed("sybil-1", ED1))).toBe("unknown_attester");
    const onlyNames = registryAuthorizer(simulationAttesterRegistry([entity("auditor-1")]));
    expect(reason(onlyNames, signed("auditor-1", ED1))).toBe("key_not_registered");
  });

  it("refuses unknown, inactive and out-of-role attesters", () => {
    expect(reason(az, recorded("nobody"))).toBe("unknown_attester");
    expect(reason(az, recorded("auditor-1", "agronomist"))).toBe("role_not_held");
    for (const status of ["suspended", "revoked"] as const) expect(reason(registryAuthorizer(simulationAttesterRegistry([entity("x", [], { status })])), recorded("x"))).toBe("attester_not_active");
  });

  it("checks the key's validity window at the attestation's issue time", () => {
    const w = registryAuthorizer(simulationAttesterRegistry([entity("a", [key("k", ED1, { validFrom: "2026-03-01T00:00:00Z", validUntil: "2026-06-01T00:00:00+03:30" })])]));
    expect(reason(w, signed("a", ED1, "2026-02-28T23:59:59Z"))).toBe("key_not_valid_at_issue");
    expect(reason(w, signed("a", ED1, "2026-03-01T00:00:00Z"))).toBe("ok:a:k");
    // validUntil is exclusive, compared as instants (offsets respected).
    expect(reason(w, signed("a", ED1, "2026-05-31T20:29:59Z"))).toBe("ok:a:k");
    expect(reason(w, signed("a", ED1, "2026-05-31T20:30:00Z"))).toBe("key_not_valid_at_issue");
  });

  it("applies the registry's explicit revocation effect (pending D-23)", () => {
    const keys = [key("k", ED1, { revokedAt: "2026-10-01T00:00:00Z" })];
    const all = registryAuthorizer(simulationAttesterRegistry([entity("a", keys)], "invalidates_all"));
    const later = registryAuthorizer(simulationAttesterRegistry([entity("a", keys)], "from_revocation_time"));
    const before = signed("a", ED1, "2026-09-30T00:00:00Z");
    const after = signed("a", ED1, "2026-10-01T00:00:00Z");
    expect([reason(all, before), reason(all, after)]).toEqual(["key_revoked", "key_revoked"]);
    expect([reason(later, before), reason(later, after)]).toEqual(["ok:a:k", "key_revoked"]);
  });

  it("is fail-closed: real cycles need an approved registry, and none can be used before D-23", () => {
    expect(() => az.authorize({ simulation: false }, recorded("auditor-1"))).toThrow(YieldRecordError);
    const approved = registryAuthorizer({ ...simulationAttesterRegistry([entity("a")]), status: "approved" });
    expect(() => approved.authorize({ simulation: true }, recorded("a"))).toThrow(YieldRecordError);
    expect(() => registryAuthorizer({ ...simulationAttesterRegistry([entity("a")]), status: "draft" }).authorize({ simulation: false }, recorded("a"))).toThrow(YieldRecordError);
  });
});

describe("Option B registry: validation", () => {
  it("refuses one key under two entities (key sharing would re-open Sybil filling)", () => {
    expect(attesterRegistryProblems(simulationAttesterRegistry([entity("a", [key("k1", ED1)]), entity("b", [key("k2", ED1)])]))).toEqual(["entities[1].keys[0] is already registered to a: a key belongs to one entity"]);
    expect(() => registryAuthorizer(simulationAttesterRegistry([entity("a", [key("k1", ED1)]), entity("b", [key("k2", ED1)])]))).toThrow(AttesterAuthorizationError);
  });

  it("refuses unusable keys, including small-order Ed25519 keys", () => {
    const smallOrder = "01" + "00".repeat(31);
    expect(attesterRegistryProblems(simulationAttesterRegistry([entity("a", [key("k", smallOrder)])]))[0]).toMatch(/small order/);
    expect(attesterRegistryProblems(simulationAttesterRegistry([entity("a", [key("k", ED1.toUpperCase())])]))).toHaveLength(1);
  });

  it("has no defaults: fields are required, none is written as null, and unsupported keys are refused", () => {
    expect(attesterRegistryProblems({})).toHaveLength(6);
    const { revocationEffect: _r, ...noEffect } = simulationAttesterRegistry([]);
    expect(attesterRegistryProblems(noEffect)).toEqual(["revocationEffect must be one of invalidates_all, from_revocation_time"]);
    const { revokedAt: _k, ...noRevoked } = key("k", ED1);
    expect(attesterRegistryProblems(simulationAttesterRegistry([entity("a", [noRevoked as never])]))).toEqual(["entities[0].keys[0].revokedAt must be given (null for none)"]);
    expect(attesterRegistryProblems({ ...simulationAttesterRegistry([]), trustAnchors: [] })).toEqual(["registry has unsupported keys: trustAnchors"]);
  });

  it("refuses repeated ids, empty or repeated roles, bad times and inverted windows", () => {
    const p = (entities: AttesterEntity[]) => attesterRegistryProblems(simulationAttesterRegistry(entities));
    expect(p([entity("a"), entity("a")])).toHaveLength(1);
    expect(p([entity("a", [key("k", ED1)]), entity("b", [key("k", ED2)])])).toHaveLength(1);
    expect(p([entity("a", [], { roles: [] })])).toHaveLength(1);
    expect(p([entity("a", [], { roles: ["x", "x"] })])).toHaveLength(1);
    expect(p([entity("a", [key("k", ED1, { validFrom: "2026-02-30T00:00:00Z" })])])).toHaveLength(1);
    expect(p([entity("a", [key("k", ED1, { validUntil: "2025-12-31T00:00:00Z" })])])).toEqual(["entities[0].keys[0].validUntil must be after validFrom"]);
    expect(p([entity("a", [key("k", ED1, { revokedAt: "2025-12-31T00:00:00Z" })])])).toEqual(["entities[0].keys[0].revokedAt must not be before validFrom"]);
  });
});

describe("authorized quorum", () => {
  const methods: AttestationMethodList = { id: "m", version: 1, status: "simulation", methods: ["recorded"], keyAlgorithms: [] };
  const quorum: AttestationQuorum = { id: "q", version: 1, status: "simulation", assetClass: "crop", rules: [{ role: "auditor", minimumAttesters: 2 }], attesterMayFillSeveralRoles: false };
  const az = registryAuthorizer(simulationAttesterRegistry([entity("a1"), entity("a2")]));

  it("counts registered entities", async () => {
    expect((await evaluateAuthorizedQuorum(sim, quorum, methods, az, [H1], [recorded("a1"), recorded("a2")])).met).toBe(true);
  });

  it("refuses the whole evaluation when any attester is not authorized (no Sybil names)", async () => {
    await expect(evaluateAuthorizedQuorum(sim, quorum, methods, az, [H1], [recorded("a1"), recorded("sybil")])).rejects.toBeInstanceOf(AttesterAuthorizationError);
    await expect(evaluateAuthorizedQuorum(sim, quorum, methods, az, [H1], [recorded("a1"), recorded("sybil")])).rejects.toThrow(/not a registered attester/);
  });

  it("accepts any identity model through the interface, and refuses one that renames attesters", async () => {
    const everyone: AttesterAuthorizer = { model: "test-allow-all", authorize: (_c, a) => ({ authorized: true, entityId: a.attester, keyId: null }) };
    expect((await evaluateAuthorizedQuorum(sim, quorum, methods, everyone, [H1], [recorded("x"), recorded("y")])).met).toBe(true);
    const renaming: AttesterAuthorizer = { model: "test-rename", authorize: () => ({ authorized: true, entityId: "same", keyId: null }) };
    await expect(evaluateAuthorizedQuorum(sim, quorum, methods, renaming, [H1], [recorded("x"), recorded("y")])).rejects.toBeInstanceOf(AttesterAuthorizationError);
  });
});
