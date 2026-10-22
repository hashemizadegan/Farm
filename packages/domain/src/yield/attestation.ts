/**
 * Attestations (Real Yield Distribution plan, revision 4, §5.4): who vouches for which hashes.
 *
 * An attestation is `{ attester, role, statement, subjectHashes, issuedAt, revokes, proof }`, where the
 * proof is one of the three methods of §5.4:
 * - `recorded`: an authenticated user with the attester role, referenced by its audit event;
 * - `document_signature`: the SHA-256 of the signed document (e.g. a signed PDF);
 * - `key_signature`: an Ed25519 or ECDSA P-256 signature over a domain-separated message.
 *
 * The platform **verifies** key signatures and never produces them: nothing here takes or creates a
 * private key. Which methods and algorithms a real cycle may rely on, and the quorum per asset class,
 * are open decisions (D-23): a real cycle accepts an attestation only under an `approved` method list,
 * a simulation cycle only under a `simulation` one. The quorum is not evaluated here.
 *
 * Revocation is a revoking attestation (`revokes` = the hash of the attestation it revokes).
 */
import { canonicalJson } from "../harvest";
import { contentHash, isSha256Hex } from "../twin/commitments";
import { isRfc3339WithOffset } from "./evidence";
import { YIELD_RECORD_STATUSES, assertYieldRecordUsable, type YieldRecordStatus } from "./records";

/** Domain separator for signed attestation messages and attestation hashes. */
export const ATTESTATION_SCHEME = "metafarm-yield-attestation/1";

export const ATTESTATION_METHODS = ["recorded", "document_signature", "key_signature"] as const;
export type AttestationMethod = (typeof ATTESTATION_METHODS)[number];

/**
 * Key-signature algorithms this library can verify. Public keys and signatures are lowercase hex:
 * - `ed25519`: 32-byte public key, 64-byte signature (RFC 8032);
 * - `ecdsa_p256_sha256`: 65-byte uncompressed SEC1 public key (`04‖x‖y`), 64-byte `r‖s` signature
 *   (IEEE P1363, not DER), SHA-256 over the message.
 * Others (e.g. secp256k1) are refused as unsupported, not approximated.
 */
export const KEY_SIGNATURE_ALGORITHMS = ["ed25519", "ecdsa_p256_sha256"] as const;
export type KeySignatureAlgorithm = (typeof KEY_SIGNATURE_ALGORITHMS)[number];

export type AttestationProof =
  | { method: "recorded"; auditEventId: string }
  | { method: "document_signature"; signedDocumentSha256: string }
  | { method: "key_signature"; algorithm: KeySignatureAlgorithm; publicKey: string; signature: string };

export interface Attestation {
  /** The attester's identifier (a user id for `recorded`; the signer's identity otherwise). */
  attester: string;
  /** The role the attester acts in (e.g. auditor); which roles count is D-23. */
  role: string;
  statement: string;
  /** SHA-256 hashes attested to (evidence items, manifests or artifacts); unique, any order. */
  subjectHashes: string[];
  issuedAt: string;
  /** The hash of the attestation this one revokes, or null. */
  revokes: string | null;
  proof: AttestationProof;
}

/** The D-23 method list a cycle's attestations are checked against. */
export interface AttestationMethodList {
  id: string;
  version: number;
  status: YieldRecordStatus;
  methods: AttestationMethod[];
  /** Key algorithms accepted when `key_signature` is listed; must be empty otherwise. */
  keyAlgorithms: KeySignatureAlgorithm[];
}

export type YieldAttestationErrorCode = "invalid_attestation" | "method_not_allowed" | "unsupported_algorithm" | "malformed_key" | "malformed_signature" | "signature_invalid";

export class YieldAttestationError extends Error {
  constructor(
    readonly code: YieldAttestationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "YieldAttestationError";
  }
}

const HEX = /^(?:[0-9a-f]{2})+$/;
const ATT_KEYS = ["attester", "role", "statement", "subjectHashes", "issuedAt", "revokes", "proof"];
const PROOF_KEYS: Record<AttestationMethod, string[]> = {
  recorded: ["method", "auditEventId"],
  document_signature: ["method", "signedDocumentSha256"],
  key_signature: ["method", "algorithm", "publicKey", "signature"],
};
const KEY_BYTES: Record<KeySignatureAlgorithm, { publicKey: number; signature: number }> = {
  ed25519: { publicKey: 32, signature: 64 },
  ecdsa_p256_sha256: { publicKey: 65, signature: 64 },
};

const unsupported = (path: string, o: Record<string, unknown>, allowed: string[]) => {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  return extra.length ? [`${path} has unsupported keys: ${extra.sort().join(", ")}`] : [];
};
const nonEmpty = (v: unknown) => typeof v === "string" && v.trim() !== "" && v.trim() === v;

/** Every problem with an attestation's shape, or an empty list. Does not verify signatures. */
export function attestationProblems(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["an attestation must be an object"];
  const o = v as Record<string, unknown>;
  const out = unsupported("attestation", o, ATT_KEYS);
  for (const k of ATT_KEYS) if (!Object.prototype.hasOwnProperty.call(o, k)) out.push(`${k} must be given${k === "revokes" ? " (null for none)" : ""}`);
  for (const k of ["attester", "role", "statement"]) if (k in o && !nonEmpty(o[k])) out.push(`${k} must be a non-empty string without surrounding whitespace`);
  if ("issuedAt" in o && !isRfc3339WithOffset(o.issuedAt)) out.push("issuedAt must be RFC 3339 with an offset");
  if ("subjectHashes" in o) {
    const s = o.subjectHashes;
    if (!Array.isArray(s) || s.length === 0 || !s.every(isSha256Hex)) out.push("subjectHashes must be a non-empty list of SHA-256 hex hashes");
    else if (new Set(s).size !== s.length) out.push("subjectHashes must not repeat a hash");
  }
  if ("revokes" in o && o.revokes !== null && !isSha256Hex(o.revokes)) out.push("revokes must be an attestation hash or null");
  if ("proof" in o) {
    const p = o.proof as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || !(ATTESTATION_METHODS as readonly unknown[]).includes(p.method)) out.push(`proof.method must be one of ${ATTESTATION_METHODS.join(", ")}`);
    else {
      const method = p.method as AttestationMethod;
      out.push(...unsupported("proof", p, PROOF_KEYS[method]));
      if (method === "recorded" && !nonEmpty(p.auditEventId)) out.push("proof.auditEventId must be a non-empty string");
      if (method === "document_signature" && !isSha256Hex(p.signedDocumentSha256)) out.push("proof.signedDocumentSha256 must be a SHA-256 hex hash");
      if (method === "key_signature") {
        if (!(KEY_SIGNATURE_ALGORITHMS as readonly unknown[]).includes(p.algorithm)) out.push(`proof.algorithm must be one of ${KEY_SIGNATURE_ALGORITHMS.join(", ")}`);
        for (const k of ["publicKey", "signature"]) if (typeof p[k] !== "string" || !HEX.test(p[k] as string)) out.push(`proof.${k} must be lowercase hex`);
      }
    }
  }
  return out;
}

export function assertAttestation(v: unknown): asserts v is Attestation {
  const p = attestationProblems(v);
  if (p.length) throw new YieldAttestationError("invalid_attestation", `invalid attestation: ${p.join("; ")}`);
}

/**
 * The exact bytes a `key_signature` attestation signs: UTF-8 canonical JSON of the claim, prefixed by
 * the domain separator and bound to the algorithm and public key, with subject hashes sorted.
 */
export function attestationSignedMessage(a: Attestation): Uint8Array {
  assertAttestation(a);
  if (a.proof.method !== "key_signature") throw new YieldAttestationError("invalid_attestation", "only key-signature attestations have a signed message");
  return new TextEncoder().encode(
    canonicalJson({
      scheme: ATTESTATION_SCHEME,
      attester: a.attester,
      role: a.role,
      statement: a.statement,
      subjectHashes: [...a.subjectHashes].sort(),
      issuedAt: a.issuedAt,
      revokes: a.revokes,
      algorithm: a.proof.algorithm,
      publicKey: a.proof.publicKey,
    }),
  );
}

/** SHA-256 (lowercase hex) identifying the attestation (canonical JSON, subject hashes sorted). */
export async function attestationHash(a: Attestation): Promise<string> {
  assertAttestation(a);
  return contentHash(canonicalJson({ scheme: ATTESTATION_SCHEME, ...a, subjectHashes: [...a.subjectHashes].sort() }));
}

/** Fresh ArrayBuffer-backed bytes, as Web Crypto's BufferSource requires. */
function bytes(hex: string) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const ED25519_P = (1n << 255n) - 19n;
/**
 * Encodings (sign bit cleared) of the Ed25519 points of small order, as listed by libsodium. Web Crypto
 * (OpenSSL) verifies signatures under such keys: with the identity point as public key, R = identity and
 * S = 0 verifies for **every** message, so a "signature" could be made without any secret.
 */
const ED25519_SMALL_ORDER = new Set([
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
]);

/**
 * Refuses Ed25519 public keys that are non-canonical (y ≥ p, RFC 8032 §5.1.3) or of small order, whatever
 * the sign bit. Both are refused as `malformed_key` before Web Crypto sees them.
 */
function assertEd25519PublicKeyUsable(publicKeyHex: string): void {
  const masked = publicKeyHex.slice(0, 62) + (parseInt(publicKeyHex.slice(62, 64), 16) & 0x7f).toString(16).padStart(2, "0");
  const y = BigInt("0x" + (masked.match(/../g) ?? []).reverse().join(""));
  if (y >= ED25519_P) throw new YieldAttestationError("malformed_key", "the ed25519 public key is not canonically encoded");
  if (ED25519_SMALL_ORDER.has(masked)) throw new YieldAttestationError("malformed_key", "the ed25519 public key is a point of small order");
}

/**
 * Verifies a signature with Web Crypto. Returns false for a well-formed signature that does not verify;
 * throws for an unsupported algorithm or a key or signature of the wrong shape, and for Ed25519 keys that
 * are non-canonical or of small order.
 *
 * A valid signature proves only that the holder of `publicKeyHex` signed. Binding an attester's identity to
 * an approved key is not done here: it is part of the attester identity requirements (D-23).
 */
export async function verifyKeySignature(algorithm: KeySignatureAlgorithm, publicKeyHex: string, message: Uint8Array, signatureHex: string): Promise<boolean> {
  if (!(KEY_SIGNATURE_ALGORITHMS as readonly unknown[]).includes(algorithm)) throw new YieldAttestationError("unsupported_algorithm", `unsupported key algorithm ${String(algorithm)}`);
  const size = KEY_BYTES[algorithm];
  if (typeof publicKeyHex !== "string" || !HEX.test(publicKeyHex) || publicKeyHex.length !== size.publicKey * 2) throw new YieldAttestationError("malformed_key", `a ${algorithm} public key is ${size.publicKey} bytes of lowercase hex`);
  if (algorithm === "ecdsa_p256_sha256" && !publicKeyHex.startsWith("04")) throw new YieldAttestationError("malformed_key", "a P-256 public key must be uncompressed (04‖x‖y)");
  if (typeof signatureHex !== "string" || !HEX.test(signatureHex) || signatureHex.length !== size.signature * 2) throw new YieldAttestationError("malformed_signature", `a ${algorithm} signature is ${size.signature} bytes of lowercase hex`);
  if (!(message instanceof Uint8Array)) throw new YieldAttestationError("invalid_attestation", "the message must be bytes");
  if (algorithm === "ed25519") assertEd25519PublicKeyUsable(publicKeyHex);

  const subtle = globalThis.crypto.subtle;
  const params = algorithm === "ed25519" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" };
  const key = await subtle.importKey("raw", bytes(publicKeyHex), params, false, ["verify"]).catch(() => {
    throw new YieldAttestationError("malformed_key", `the ${algorithm} public key is not a valid point`);
  });
  const verifyParams = algorithm === "ed25519" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
  return subtle.verify(verifyParams, key, bytes(signatureHex), new Uint8Array(message));
}

/** Every problem with a D-23 method list, or an empty list. */
export function attestationMethodListProblems(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["a method list must be an object"];
  const o = v as Record<string, unknown>;
  const out = unsupported("method list", o, ["id", "version", "status", "methods", "keyAlgorithms"]);
  if (!nonEmpty(o.id)) out.push("id must be a non-empty string");
  if (!(typeof o.version === "number" && Number.isSafeInteger(o.version) && o.version >= 1)) out.push("version must be an integer ≥ 1");
  if (!(YIELD_RECORD_STATUSES as readonly unknown[]).includes(o.status)) out.push(`status must be one of ${YIELD_RECORD_STATUSES.join(", ")}`);
  const list = (k: string, allowed: readonly string[]) => {
    const v2 = o[k];
    if (!Array.isArray(v2) || !v2.every((x) => allowed.includes(x)) || new Set(v2).size !== v2.length) out.push(`${k} must be a list of distinct values from ${allowed.join(", ")}`);
  };
  list("methods", ATTESTATION_METHODS);
  list("keyAlgorithms", KEY_SIGNATURE_ALGORITHMS);
  if (Array.isArray(o.methods) && Array.isArray(o.keyAlgorithms)) {
    const keyed = o.methods.includes("key_signature");
    if (keyed && o.keyAlgorithms.length === 0) out.push("keyAlgorithms must name at least one algorithm when key_signature is allowed");
    if (!keyed && o.keyAlgorithms.length > 0) out.push("keyAlgorithms must be empty when key_signature is not allowed");
  }
  return out;
}

/**
 * Accepts an attestation for a cycle, or throws. The method list must be usable by the cycle (`approved`
 * for a real cycle, `simulation` for a simulation cycle), list the attestation's method (and algorithm),
 * and a key signature must verify over `attestationSignedMessage`. Quorum is not evaluated here (D-23).
 */
export async function assertAttestationAccepted(cycle: { simulation: boolean }, methods: AttestationMethodList, a: Attestation): Promise<void> {
  const problems = attestationMethodListProblems(methods);
  if (problems.length) throw new YieldAttestationError("method_not_allowed", `invalid attestation method list: ${problems.join("; ")}`);
  assertYieldRecordUsable(cycle, { status: methods.status, kind: "attestation method list" });
  assertAttestation(a);
  if (!methods.methods.includes(a.proof.method)) throw new YieldAttestationError("method_not_allowed", `the method list does not allow ${a.proof.method} attestations`);
  if (a.proof.method === "key_signature") {
    if (!methods.keyAlgorithms.includes(a.proof.algorithm)) throw new YieldAttestationError("method_not_allowed", `the method list does not allow ${a.proof.algorithm} signatures`);
    if (!(await verifyKeySignature(a.proof.algorithm, a.proof.publicKey, attestationSignedMessage(a), a.proof.signature))) throw new YieldAttestationError("signature_invalid", "the signature does not verify");
  }
}
