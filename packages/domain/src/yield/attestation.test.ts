import { describe, expect, it } from "vitest";
import {
  type Attestation,
  type AttestationMethodList,
  type YieldAttestationError,
  assertAttestationAccepted,
  attestationHash,
  attestationMethodListProblems,
  attestationProblems,
  attestationSignedMessage,
  verifyKeySignature,
} from "./attestation";
import { YieldRecordError } from "./records";

const sha256 = async (b: Uint8Array) => [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(b)))].map((x) => x.toString(16).padStart(2, "0")).join("");

// Published test vectors only; nothing here creates a key or a signature.
const RFC8032_T1 = {
  publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  message: new Uint8Array(),
  signature: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
};
const RFC8032_T2 = {
  publicKey: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
  message: Uint8Array.of(0x72),
  signature: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
};
// RFC 6979 A.2.5: P-256, SHA-256, message "sample".
const RFC6979_P256 = {
  publicKey: "0460fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299",
  message: new TextEncoder().encode("sample"),
  signature: "efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8",
};

const SUBJECTS = ["ed8d97c08bf3add20118c75a4e92eb49af62ed9b602a6e60b3e5e87e440f5726", "5436e7948ad1df5d02e9d2e310ab6cc9b60f3055d093d69ae1fb32a525738982"];
const base = { attester: "auditor-1", role: "auditor", statement: "I examined these items.", subjectHashes: SUBJECTS, issuedAt: "2026-10-02T09:00:00Z", revokes: null };
const keyed: Attestation = { ...base, proof: { method: "key_signature", algorithm: "ed25519", publicKey: RFC8032_T1.publicKey, signature: RFC8032_T1.signature } };
const recorded: Attestation = { ...base, proof: { method: "recorded", auditEventId: "audit-42" } };
const document: Attestation = { ...base, proof: { method: "document_signature", signedDocumentSha256: SUBJECTS[0]! } };

const list = (status: AttestationMethodList["status"], methods: AttestationMethodList["methods"], keyAlgorithms: AttestationMethodList["keyAlgorithms"] = []): AttestationMethodList => ({
  id: "methods",
  version: 1,
  status,
  methods,
  keyAlgorithms,
});
const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (e) {
    return (e as YieldAttestationError).code ?? (e as Error).name;
  }
  return "no error";
};

describe("key-signature verification (published vectors)", () => {
  it("verifies RFC 8032 Ed25519 tests 1 and 2, and rejects a changed message", async () => {
    expect(await verifyKeySignature("ed25519", RFC8032_T1.publicKey, RFC8032_T1.message, RFC8032_T1.signature)).toBe(true);
    expect(await verifyKeySignature("ed25519", RFC8032_T2.publicKey, RFC8032_T2.message, RFC8032_T2.signature)).toBe(true);
    expect(await verifyKeySignature("ed25519", RFC8032_T2.publicKey, Uint8Array.of(0x73), RFC8032_T2.signature)).toBe(false);
    expect(await verifyKeySignature("ed25519", RFC8032_T1.publicKey, RFC8032_T2.message, RFC8032_T2.signature)).toBe(false);
  });

  it("verifies RFC 6979 A.2.5 ECDSA P-256 / SHA-256, and rejects a changed message", async () => {
    expect(await verifyKeySignature("ecdsa_p256_sha256", RFC6979_P256.publicKey, RFC6979_P256.message, RFC6979_P256.signature)).toBe(true);
    expect(await verifyKeySignature("ecdsa_p256_sha256", RFC6979_P256.publicKey, new TextEncoder().encode("test"), RFC6979_P256.signature)).toBe(false);
  });

  it("refuses unsupported algorithms and malformed keys or signatures instead of returning false", async () => {
    expect(await code(() => verifyKeySignature("secp256k1" as never, RFC8032_T1.publicKey, new Uint8Array(), RFC8032_T1.signature))).toBe("unsupported_algorithm");
    expect(await code(() => verifyKeySignature("ed25519", RFC8032_T1.publicKey.slice(2), new Uint8Array(), RFC8032_T1.signature))).toBe("malformed_key");
    expect(await code(() => verifyKeySignature("ed25519", RFC8032_T1.publicKey.toUpperCase(), new Uint8Array(), RFC8032_T1.signature))).toBe("malformed_key");
    expect(await code(() => verifyKeySignature("ed25519", RFC8032_T1.publicKey, new Uint8Array(), RFC8032_T1.signature + "00"))).toBe("malformed_signature");
    // Compressed P-256 keys and DER signatures are not accepted.
    expect(await code(() => verifyKeySignature("ecdsa_p256_sha256", "02" + RFC6979_P256.publicKey.slice(2, 66) + "00".repeat(32), RFC6979_P256.message, RFC6979_P256.signature))).toBe("malformed_key");
    expect(await code(() => verifyKeySignature("ecdsa_p256_sha256", "04" + "00".repeat(64), RFC6979_P256.message, RFC6979_P256.signature))).toBe("malformed_key");
    // A DER-encoded ECDSA signature (here 72 bytes) is refused; only 64-byte r‖s is accepted.
    expect(await code(() => verifyKeySignature("ecdsa_p256_sha256", RFC6979_P256.publicKey, RFC6979_P256.message, "30460221" + "00" + RFC6979_P256.signature.slice(0, 64) + "022100" + RFC6979_P256.signature.slice(64)))).toBe("malformed_signature");
  });
});

describe("attestation messages and hashes", () => {
  it("signs a domain-separated message bound to the algorithm and key, matching an independent vector", async () => {
    const msg = attestationSignedMessage(keyed);
    expect(new TextDecoder().decode(msg).startsWith('{"algorithm":"ed25519","attester":"auditor-1"')).toBe(true);
    expect(new TextDecoder().decode(msg)).toContain('"scheme":"metafarm-yield-attestation/1"');
    // Python: json.dumps(message, sort_keys=True, separators=(",", ":")) → hashlib.sha256.
    expect(await sha256(msg)).toBe("f85390b3b6d313a441a367aa825217d02fd25ed64290bdbf7181e66b092be3b5");
  });

  it("orders subject hashes canonically in the message and the hash", async () => {
    const reversed = { ...keyed, subjectHashes: [...SUBJECTS].reverse() };
    expect(attestationSignedMessage(reversed)).toEqual(attestationSignedMessage(keyed));
    expect(await attestationHash(reversed)).toBe(await attestationHash(keyed));
    expect(await attestationHash(recorded)).not.toBe(await attestationHash(document));
  });

  it("only key-signature attestations have a signed message", () => {
    expect(() => attestationSignedMessage(recorded)).toThrow();
  });
});

describe("attestation shape", () => {
  it("accepts all three methods", () => {
    for (const a of [keyed, recorded, document]) expect(attestationProblems(a)).toEqual([]);
    expect(attestationProblems({ ...recorded, revokes: SUBJECTS[1] })).toEqual([]);
  });

  it("refuses missing, empty, repeated and unsupported fields", () => {
    expect(attestationProblems({})).toHaveLength(7);
    expect(attestationProblems({ ...recorded, subjectHashes: [] })).toHaveLength(1);
    expect(attestationProblems({ ...recorded, subjectHashes: [SUBJECTS[0], SUBJECTS[0]] })).toEqual(["subjectHashes must not repeat a hash"]);
    expect(attestationProblems({ ...recorded, issuedAt: "2026-10-02" })).toHaveLength(1);
    expect(attestationProblems({ ...recorded, role: "" })).toHaveLength(1);
    expect(attestationProblems({ ...recorded, weight: 2 })).toEqual(["attestation has unsupported keys: weight"]);
    expect(attestationProblems({ ...recorded, proof: { method: "recorded", auditEventId: "a", signature: "00" } })).toEqual(["proof has unsupported keys: signature"]);
    expect(attestationProblems({ ...recorded, proof: { method: "notarised" } })).toHaveLength(1);
  });
});

describe("acceptance under a D-23 method list", () => {
  it("accepts methods the list allows, with a usable list for the cycle", async () => {
    await expect(assertAttestationAccepted({ simulation: true }, list("simulation", ["recorded", "document_signature"]), recorded)).resolves.toBeUndefined();
    await expect(assertAttestationAccepted({ simulation: false }, list("approved", ["document_signature"]), document)).resolves.toBeUndefined();
  });

  it("refuses real attestations without an approved list, and simulation lists for real cycles", async () => {
    expect(await code(() => assertAttestationAccepted({ simulation: false }, list("draft", ["recorded"]), recorded))).toBe("YieldRecordError");
    expect(await code(() => assertAttestationAccepted({ simulation: false }, list("simulation", ["recorded"]), recorded))).toBe("YieldRecordError");
    expect(await code(() => assertAttestationAccepted({ simulation: true }, list("approved", ["recorded"]), recorded))).toBe("YieldRecordError");
    await expect(assertAttestationAccepted({ simulation: false }, list("draft", ["recorded"]), recorded)).rejects.toBeInstanceOf(YieldRecordError);
  });

  it("refuses methods and algorithms the list does not allow", async () => {
    expect(await code(() => assertAttestationAccepted({ simulation: true }, list("simulation", ["document_signature"]), recorded))).toBe("method_not_allowed");
    expect(await code(() => assertAttestationAccepted({ simulation: true }, list("simulation", ["key_signature"], ["ecdsa_p256_sha256"]), keyed))).toBe("method_not_allowed");
  });

  it("verifies key signatures over the attestation message", async () => {
    // The RFC 8032 signature is over the empty message, not this attestation's message, so it must fail.
    expect(await code(() => assertAttestationAccepted({ simulation: true }, list("simulation", ["key_signature"], ["ed25519"]), keyed))).toBe("signature_invalid");
  });

  it("validates the method list itself", () => {
    expect(attestationMethodListProblems(list("approved", ["recorded"]))).toEqual([]);
    expect(attestationMethodListProblems(list("approved", ["key_signature"]))).toEqual(["keyAlgorithms must name at least one algorithm when key_signature is allowed"]);
    expect(attestationMethodListProblems(list("approved", ["recorded"], ["ed25519"]))).toEqual(["keyAlgorithms must be empty when key_signature is not allowed"]);
    expect(attestationMethodListProblems(list("approved", ["recorded", "recorded"]))).toHaveLength(1);
    expect(attestationMethodListProblems({ ...list("approved", ["recorded"]), quorum: 2 })).toEqual(["method list has unsupported keys: quorum"]);
    expect(attestationMethodListProblems({})).toHaveLength(5);
  });
});
