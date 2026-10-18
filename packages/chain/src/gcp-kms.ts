/**
 * Signers backed by Google Cloud KMS, over its REST API (no Google SDK): Ed25519 keys
 * (EC_SIGN_ED25519, pure EdDSA over the raw message) for Solana and secp256k1 keys
 * (EC_SIGN_SECP256K1_SHA256, over a SHA-256 digest) for TRON. The private keys never leave KMS.
 *
 * Every call carries CRC32C checksums both ways, the key version that answered must be the one
 * configured, and each signature is verified locally against the key's public half before it is
 * used, so a corrupted or substituted response can never reach a chain.
 */
import { createSign } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import type { Ed25519Signer, TronSigner } from "@metafarm/domain";
import { concatBytes, fromBase64, fromHex, toBase64, toHex } from "./bytes";
import { base58Encode } from "./solana/base58";
import { tronAddressOfPublicKey } from "./tron/address";

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export const KMS_KEY_VERSION = /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+\/cryptoKeyVersions\/[0-9]+$/;
const KMS_API = "https://cloudkms.googleapis.com/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloudkms";

// ── CRC32C (Castagnoli), as KMS uses for integrity ─────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32c(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Auth: a service account's key, exchanged for short-lived tokens ─────

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface KmsAuth {
  token(): Promise<string>;
}

export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let key: Partial<ServiceAccountKey> & { type?: string };
  try {
    key = JSON.parse(json) as typeof key;
  } catch {
    throw new Error("the KMS credentials are not valid JSON");
  }
  if (key.type !== "service_account" || !key.client_email || !key.private_key?.includes("PRIVATE KEY")) throw new Error("the KMS credentials are not a service account key");
  return { client_email: key.client_email, private_key: key.private_key, token_uri: key.token_uri };
}

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

/** OAuth2 JWT-bearer flow; tokens are reused until a minute before they expire. */
export function serviceAccountAuth(key: ServiceAccountKey, fetchImpl: Fetch = fetch as unknown as Fetch, now = () => Date.now()): KmsAuth {
  let cached: { token: string; until: number } | undefined;
  const tokenUri = key.token_uri ?? TOKEN_URL;
  return {
    async token() {
      if (cached && cached.until > now()) return cached.token;
      const iat = Math.floor(now() / 1000);
      const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3600 }))}`;
      const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key);
      const res = await fetchImpl(tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(signature)}` }).toString(),
      });
      if (!res.ok) throw new Error(`KMS sign-in failed (${res.status})`);
      const body = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!body.access_token) throw new Error("KMS sign-in returned no token");
      cached = { token: body.access_token, until: now() + Math.max((body.expires_in ?? 3600) - 60, 0) * 1000 };
      return cached.token;
    },
  };
}

// ── The API ─────────────────────────────────────────────────────────────

export interface KmsClient {
  publicKey(keyVersion: string): Promise<{ algorithm: string; pem: string }>;
  sign(keyVersion: string, input: { data: Uint8Array } | { sha256: Uint8Array }): Promise<Uint8Array>;
}

export function gcpKmsClient(auth: KmsAuth, fetchImpl: Fetch = fetch as unknown as Fetch, attempts = 3): KmsClient {
  async function call(url: string, method: string, body?: object) {
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${await auth.token()}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`KMS ${method} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as Record<string, unknown>;
  }
  return {
    async publicKey(keyVersion) {
      const r = await call(`${KMS_API}/${keyVersion}/publicKey`, "GET");
      const pem = String(r.pem ?? "");
      if (r.name !== keyVersion) throw new Error("KMS answered for a different key version");
      if (r.pemCrc32c !== undefined && Number(r.pemCrc32c) !== crc32c(new TextEncoder().encode(pem))) throw new Error("KMS public key failed its checksum");
      return { algorithm: String(r.algorithm), pem };
    },
    async sign(keyVersion, input) {
      const payload = "data" in input ? input.data : input.sha256;
      const body = "data" in input
        ? { data: toBase64(payload), dataCrc32c: String(crc32c(payload)) }
        : { digest: { sha256: toBase64(payload) }, digestCrc32c: String(crc32c(payload)) };
      let last: unknown;
      for (let i = 0; i < attempts; i++) {
        const r = await call(`${KMS_API}/${keyVersion}:asymmetricSign`, "POST", body);
        const signature = fromBase64(String(r.signature ?? ""));
        const verified = "data" in input ? r.verifiedDataCrc32c : r.verifiedDigestCrc32c;
        if (r.name !== keyVersion) throw new Error("KMS signed with a different key version");
        // Corruption in transit either way: KMS's advice is to discard and ask again.
        if (verified !== true || Number(r.signatureCrc32c) !== crc32c(signature)) {
          last = new Error("KMS signature failed its integrity checks");
          continue;
        }
        return signature;
      }
      throw last;
    },
  };
}

// ── Public keys and signatures ──────────────────────────────────────────

const pemBody = (pem: string) => fromBase64(pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, ""));
const ED25519_SPKI = fromHex("302a300506032b6570032100");
const SECP256K1_SPKI = fromHex("3056301006072a8648ce3d020106052b8104000a034200");

function spkiKey(pem: string, prefix: Uint8Array, length: number): Uint8Array {
  const der = pemBody(pem);
  if (der.length !== prefix.length + length || toHex(der.subarray(0, prefix.length)) !== toHex(prefix)) throw new Error("unexpected public key encoding");
  return der.subarray(prefix.length);
}

/** r and s from an ASN.1 DER ECDSA signature (secp256k1: each integer at most 33 bytes). */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  const bad = () => new Error("not a DER ECDSA signature");
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) throw bad();
  let i = 2;
  const integer = () => {
    const len = der[i + 1] ?? 0;
    if (der[i] !== 0x02 || len < 1 || len > 33 || i + 2 + len > der.length) throw bad();
    const v = BigInt(`0x${toHex(der.subarray(i + 2, i + 2 + len))}`);
    i += 2 + len;
    return v;
  };
  const r = integer();
  const s = integer();
  if (i !== der.length) throw bad();
  const n = secp256k1.CURVE.n;
  if (r <= 0n || r >= n || s <= 0n || s >= n) throw bad();
  return { r, s };
}

export async function gcpKmsEd25519Signer(kms: KmsClient, keyVersion: string): Promise<Ed25519Signer> {
  const { algorithm, pem } = await kms.publicKey(keyVersion);
  if (algorithm !== "EC_SIGN_ED25519") throw new Error(`${keyVersion} is ${algorithm}, not EC_SIGN_ED25519`);
  const publicKey = spkiKey(pem, ED25519_SPKI, 32);
  return {
    address: base58Encode(publicKey),
    async signMessage(message) {
      const signature = await kms.sign(keyVersion, { data: message });
      if (signature.length !== 64 || !ed25519.verify(signature, message, publicKey)) throw new Error("KMS returned a signature that does not verify");
      return signature;
    },
  };
}

/** TRON wants r‖s‖v (v = 27 + recovery id); KMS gives DER without a recovery id, so we find it. */
export async function gcpKmsTronSigner(kms: KmsClient, keyVersion: string): Promise<TronSigner> {
  const { algorithm, pem } = await kms.publicKey(keyVersion);
  if (algorithm !== "EC_SIGN_SECP256K1_SHA256") throw new Error(`${keyVersion} is ${algorithm}, not EC_SIGN_SECP256K1_SHA256`);
  const publicKey = spkiKey(pem, SECP256K1_SPKI, 65);
  const expected = toHex(publicKey);
  const n = secp256k1.CURVE.n;
  return {
    address: tronAddressOfPublicKey(publicKey),
    async signTransactionId(txIdHex) {
      const digest = fromHex(txIdHex);
      if (digest.length !== 32) throw new Error("a TRON transaction id is 32 bytes");
      const { r, s: raw } = parseDerSignature(await kms.sign(keyVersion, { sha256: digest }));
      const s = raw > n / 2n ? n - raw : raw; // low-s, as the chain requires
      for (const recovery of [0, 1]) {
        const sig = new secp256k1.Signature(r, s).addRecoveryBit(recovery);
        if (toHex(sig.recoverPublicKey(digest).toRawBytes(false)) === expected) {
          return toHex(concatBytes(sig.toCompactRawBytes(), Uint8Array.of(27 + recovery)));
        }
      }
      throw new Error("KMS returned a signature that does not recover to the key");
    },
  };
}
