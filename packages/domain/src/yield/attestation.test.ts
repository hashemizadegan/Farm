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

describe("negative vectors: Ed25519", () => {
  const flip = (hexStr: string, byte: number, mask = 0x01) => hexStr.slice(0, byte * 2) + (parseInt(hexStr.slice(byte * 2, byte * 2 + 2), 16) ^ mask).toString(16).padStart(2, "0") + hexStr.slice(byte * 2 + 2);
  const ID = "01" + "00".repeat(31);

  it("refuses small-order public keys, which would otherwise verify any message (regression)", async () => {
    // With the identity as key, R = identity and S = 0 verifies for every message under Web Crypto.
    for (const msg of [new Uint8Array(), new TextEncoder().encode("forged"), attestationSignedMessage(keyed)])
      expect(await code(() => verifyKeySignature("ed25519", ID, msg, ID + "00".repeat(32)))).toBe("malformed_key");
    for (const k of [
      "00".repeat(32),
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      // the same points with the sign bit set
      "01" + "00".repeat(30) + "80",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    ])
      expect(await code(() => verifyKeySignature("ed25519", k, new Uint8Array(), ID + "00".repeat(32))), k).toBe("malformed_key");
    // An attestation using such a key is refused, not accepted.
    const forged: Attestation = { ...keyed, proof: { method: "key_signature", algorithm: "ed25519", publicKey: ID, signature: ID + "00".repeat(32) } };
    expect(await code(() => assertAttestationAccepted({ simulation: true }, list("simulation", ["key_signature"], ["ed25519"]), forged))).toBe("malformed_key");
  });

  it("refuses non-canonical key encodings (y ≥ p)", async () => {
    for (const k of ["edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "ff".repeat(31) + "7f", "ff".repeat(32)])
      expect(await code(() => verifyKeySignature("ed25519", k, RFC8032_T1.message, RFC8032_T1.signature)), k).toBe("malformed_key");
  });

  it("rejects every single-bit change to R, S or the key's low bytes", async () => {
    for (const byte of [0, 15, 31, 32, 47, 63]) expect(await verifyKeySignature("ed25519", RFC8032_T2.publicKey, RFC8032_T2.message, flip(RFC8032_T2.signature, byte)), `signature byte ${byte}`).toBe(false);
    for (const byte of [0, 15, 30]) {
      const r = await code(async () => {
        if (await verifyKeySignature("ed25519", flip(RFC8032_T2.publicKey, byte), RFC8032_T2.message, RFC8032_T2.signature)) throw new Error("verified");
      });
      // Either the changed key is not a valid point (malformed_key) or the signature does not verify.
      expect(["no error", "malformed_key"], `key byte ${byte}`).toContain(r);
    }
  });

  it("rejects a non-canonical S (S + L), which encodes the same scalar", async () => {
    const L = (1n << 252n) + 27742317777372353535851937790883648493n;
    const le = (h: string) => BigInt("0x" + h.match(/../g)!.reverse().join(""));
    const toLe = (n: bigint) => Array.from({ length: 32 }, (_, i) => ((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0")).join("");
    const s = le(RFC8032_T1.signature.slice(64));
    expect(await verifyKeySignature("ed25519", RFC8032_T1.publicKey, RFC8032_T1.message, RFC8032_T1.signature.slice(0, 64) + toLe(s + L))).toBe(false);
  });

  it("refuses trailing or missing bytes, odd lengths, prefixes and non-hex characters", async () => {
    const bad = [RFC8032_T1.signature + "00", RFC8032_T1.signature.slice(2), RFC8032_T1.signature.slice(1), "0x" + RFC8032_T1.signature.slice(2), RFC8032_T1.signature.slice(0, 126) + "zz", ""];
    for (const sig of bad) expect(await code(() => verifyKeySignature("ed25519", RFC8032_T1.publicKey, RFC8032_T1.message, sig)), sig.slice(0, 8)).toBe("malformed_signature");
    for (const key of [RFC8032_T1.publicKey + "00", RFC8032_T1.publicKey.slice(1), " " + RFC8032_T1.publicKey.slice(1), 42 as never])
      expect(await code(() => verifyKeySignature("ed25519", key, RFC8032_T1.message, RFC8032_T1.signature))).toBe("malformed_key");
    expect(await code(() => verifyKeySignature("ed25519", RFC8032_T1.publicKey, "" as never, RFC8032_T1.signature))).toBe("invalid_attestation");
  });

  it("does not verify a signature under another algorithm's key shape", async () => {
    expect(await code(() => verifyKeySignature("ecdsa_p256_sha256", RFC8032_T1.publicKey, RFC8032_T1.message, RFC8032_T1.signature))).toBe("malformed_key");
    expect(await code(() => verifyKeySignature("ed25519", RFC6979_P256.publicKey, RFC6979_P256.message, RFC6979_P256.signature))).toBe("malformed_key");
  });
});

describe("negative vectors: ECDSA P-256", () => {
  const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  const h64 = (x: bigint) => x.toString(16).padStart(64, "0");
  const r = RFC6979_P256.signature.slice(0, 64);
  const s = RFC6979_P256.signature.slice(64);
  const x = RFC6979_P256.publicKey.slice(2, 66);
  const y = RFC6979_P256.publicKey.slice(66);
  const verify = (key: string, sig: string, msg = RFC6979_P256.message) => verifyKeySignature("ecdsa_p256_sha256", key, msg, sig);

  it("rejects r or s equal to 0 or n, and r or s out of range", async () => {
    for (const sig of [h64(0n) + s, r + h64(0n), h64(n) + s, r + h64(n), "ff".repeat(32) + s, r + "ff".repeat(32), h64(0n) + h64(0n)]) expect(await verify(RFC6979_P256.publicKey, sig), sig.slice(0, 8)).toBe(false);
  });

  it("accepts both S forms (n − s also verifies); attestation hashes cover the signature bytes as given", async () => {
    expect(await verify(RFC6979_P256.publicKey, r + h64(n - BigInt("0x" + s)))).toBe(true);
  });

  it("refuses keys off the curve or with coordinates ≥ p, and does not verify under the negated point", async () => {
    expect(await code(() => verify("04" + x + h64(BigInt("0x" + y) + 1n), RFC6979_P256.signature))).toBe("malformed_key");
    expect(await code(() => verify("04" + "ff".repeat(32) + y, RFC6979_P256.signature))).toBe("malformed_key");
    expect(await code(() => verify("04" + x + h64(BigInt("0x" + y) + p), RFC6979_P256.signature))).not.toBe("no error");
    expect(await verify("04" + x + h64(p - BigInt("0x" + y)), RFC6979_P256.signature)).toBe(false);
    expect(await code(() => verify("04" + "00".repeat(64), RFC6979_P256.signature))).toBe("malformed_key");
  });

  it("refuses compressed, hybrid and point-at-infinity encodings, DER signatures and trailing bytes", async () => {
    for (const prefix of ["02", "03", "06", "07", "00"]) expect(await code(() => verify(prefix + x + y, RFC6979_P256.signature)), prefix).toBe("malformed_key");
    expect(await code(() => verify("00", RFC6979_P256.signature))).toBe("malformed_key");
    // DER: SEQUENCE { INTEGER r, INTEGER s } with r and s both having the high bit set (each 33 bytes).
    const der = "3046" + "022100" + r + "022100" + s;
    expect(await code(() => verify(RFC6979_P256.publicKey, der))).toBe("malformed_signature");
    expect(await code(() => verify(RFC6979_P256.publicKey, RFC6979_P256.signature + "00"))).toBe("malformed_signature");
    expect(await code(() => verify(RFC6979_P256.publicKey + "00", RFC6979_P256.signature))).toBe("malformed_key");
  });

  it("rejects the signature when any bit of the message, r or s changes", async () => {
    const msg = new TextEncoder().encode("samplf");
    expect(await verify(RFC6979_P256.publicKey, RFC6979_P256.signature, msg)).toBe(false);
    expect(await verify(RFC6979_P256.publicKey, RFC6979_P256.signature, new TextEncoder().encode("sample\n"))).toBe(false);
    expect(await verify(RFC6979_P256.publicKey, h64(BigInt("0x" + r) ^ 1n) + s)).toBe(false);
    expect(await verify(RFC6979_P256.publicKey, r + h64(BigInt("0x" + s) ^ 1n))).toBe(false);
  });
});

describe("domain separation of the signed message", () => {
  const text = (a: Attestation) => new TextDecoder().decode(attestationSignedMessage(a));
  const withProof = (patch: Partial<Extract<Attestation["proof"], { method: "key_signature" }>>): Attestation => ({ ...keyed, proof: { ...(keyed.proof as Extract<Attestation["proof"], { method: "key_signature" }>), ...patch } });

  it("changes the signed bytes when any signed field changes", () => {
    const base0 = text(keyed);
    const variants: Attestation[] = [
      { ...keyed, attester: "auditor-2" },
      { ...keyed, role: "agronomist" },
      { ...keyed, statement: "I examined these items" },
      { ...keyed, subjectHashes: [SUBJECTS[0]!] },
      { ...keyed, issuedAt: "2026-10-02T09:00:01Z" },
      { ...keyed, revokes: SUBJECTS[0]! },
      withProof({ algorithm: "ecdsa_p256_sha256", publicKey: RFC6979_P256.publicKey }),
      withProof({ publicKey: RFC8032_T2.publicKey }),
    ];
    const all = new Set([base0, ...variants.map(text)]);
    expect(all.size).toBe(variants.length + 1);
  });

  it("does not sign the signature itself, and the separator cannot be overridden by the caller", () => {
    expect(text(withProof({ signature: "00".repeat(64) }))).toBe(text(keyed));
    expect(text(keyed)).toContain('"scheme":"metafarm-yield-attestation/1"');
    expect(attestationProblems({ ...keyed, scheme: "metafarm-yield-evidence/1" })).toEqual(["attestation has unsupported keys: scheme"]);
  });

  it("never signs bytes that parse as an evidence manifest, a calculation artifact or another scheme", () => {
    const parsed = JSON.parse(text(keyed)) as Record<string, unknown>;
    expect(parsed.scheme).toBe("metafarm-yield-attestation/1");
    expect(Object.keys(parsed)).not.toContain("items");
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(parsed));
  });

  it("keeps a statement's characters exactly (no Unicode normalisation)", () => {
    expect(text({ ...keyed, statement: "é" })).not.toBe(text({ ...keyed, statement: "é" }));
  });
});
