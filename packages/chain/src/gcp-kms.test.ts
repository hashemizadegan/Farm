/** Cloud KMS signers against a simulated KMS that signs with real keys. */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { describe, expect, it } from "vitest";
import { concatBytes, fromBase64, fromHex, toBase64, toHex, utf8 } from "./bytes";
import { KMS_KEY_VERSION, crc32c, gcpKmsClient, gcpKmsEd25519Signer, gcpKmsTronSigner, parseDerSignature, parseServiceAccountKey, serviceAccountAuth, type KmsAuth } from "./gcp-kms";
import { base58Encode } from "./solana/base58";
import { recoverTronSigner, tronAddressOfPublicKey } from "./tron/address";

const ED_KEY = "projects/farm-rwa/locations/europe-west1/keyRings/rwa/cryptoKeys/solana-issuer/cryptoKeyVersions/1";
const K1_KEY = "projects/farm-rwa/locations/europe-west1/keyRings/rwa/cryptoKeys/tron-treasury/cryptoKeyVersions/3";
const edSeed = new Uint8Array(32).fill(21);
const k1Secret = new Uint8Array(32).fill(22);

const pem = (der: Uint8Array) => `-----BEGIN PUBLIC KEY-----\n${toBase64(der).match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
const edPem = pem(concatBytes(fromHex("302a300506032b6570032100"), ed25519.getPublicKey(edSeed)));
const k1Pem = pem(concatBytes(fromHex("3056301006072a8648ce3d020106052b8104000a034200"), secp256k1.getPublicKey(k1Secret, false)));

type Tamper = { flipSignature?: number; highS?: boolean; wrongName?: boolean; unverified?: boolean };

/** Answers like KMS's REST API, with knobs to corrupt its answers. */
function fakeKms(t: Tamper = {}) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  let corruptions = t.flipSignature ?? 0;
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    expect(init.headers.authorization).toBe("Bearer tok");
    const reply = (o: object) => ({ ok: true, status: 200, json: async () => o, text: async () => "" });
    const key = url.includes("solana-issuer") ? ED_KEY : K1_KEY;
    if (url.endsWith("/publicKey")) {
      const p = key === ED_KEY ? edPem : k1Pem;
      return reply({ name: key, pem: p, pemCrc32c: String(crc32c(utf8(p))), algorithm: key === ED_KEY ? "EC_SIGN_ED25519" : "EC_SIGN_SECP256K1_SHA256" });
    }
    let signature: Uint8Array;
    if (key === ED_KEY) {
      const data = fromBase64(String(body!.data));
      expect(Number(body!.dataCrc32c)).toBe(crc32c(data));
      signature = ed25519.sign(data, edSeed);
    } else {
      const digest = fromBase64(String((body!.digest as { sha256: string }).sha256));
      expect(Number(body!.digestCrc32c)).toBe(crc32c(digest));
      let sig = secp256k1.sign(digest, k1Secret);
      if (t.highS) sig = new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s);
      signature = sig.toDERRawBytes();
    }
    const crc = crc32c(signature);
    if (corruptions-- > 0) signature = Uint8Array.from(signature, (b, i) => (i === 5 ? b ^ 1 : b));
    return reply({
      name: t.wrongName ? K1_KEY.replace("/3", "/4") : key,
      signature: toBase64(signature),
      signatureCrc32c: String(crc),
      [key === ED_KEY ? "verifiedDataCrc32c" : "verifiedDigestCrc32c"]: !t.unverified,
      protectionLevel: key === ED_KEY ? "SOFTWARE" : "HSM",
    });
  };
  const auth: KmsAuth = { token: async () => "tok" };
  return { client: gcpKmsClient(auth, fetchImpl), calls };
}

describe("Cloud KMS signers", () => {
  it("checksums like CRC32C (Castagnoli)", () => {
    expect(crc32c(utf8("123456789"))).toBe(0xe3069283);
    expect(crc32c(new Uint8Array(0))).toBe(0);
  });

  it("accepts only full key version names", () => {
    expect(KMS_KEY_VERSION.test(ED_KEY)).toBe(true);
    expect(KMS_KEY_VERSION.test(ED_KEY.replace(/\/cryptoKeyVersions\/1$/, ""))).toBe(false);
  });

  it("signs Solana messages with an Ed25519 key, verified before use", async () => {
    const { client, calls } = fakeKms();
    const signer = await gcpKmsEd25519Signer(client, ED_KEY);
    expect(signer.address).toBe(base58Encode(ed25519.getPublicKey(edSeed)));
    const message = utf8("a compiled transaction message");
    const sig = await signer.signMessage(message);
    expect(ed25519.verify(sig, message, ed25519.getPublicKey(edSeed))).toBe(true);
    expect(calls.at(-1)!.url).toBe(`https://cloudkms.googleapis.com/v1/${ED_KEY}:asymmetricSign`);
    expect(calls.at(-1)!.body).toMatchObject({ data: toBase64(message) });
  });

  it("signs TRON transaction ids with secp256k1, low-s, with the recovery id TRON expects", async () => {
    for (const highS of [false, true]) {
      const { client, calls } = fakeKms({ highS });
      const signer = await gcpKmsTronSigner(client, K1_KEY);
      expect(signer.address).toBe(tronAddressOfPublicKey(secp256k1.getPublicKey(k1Secret, false)));
      const txId = toHex(sha256(utf8(`raw-data-${highS}`)));
      const sig = await signer.signTransactionId(txId);
      expect(sig).toHaveLength(130);
      expect(BigInt(`0x${sig.slice(64, 128)}`) <= secp256k1.CURVE.n / 2n).toBe(true);
      expect(recoverTronSigner(txId, sig)).toBe(signer.address);
      // The transaction id is already SHA-256 of the raw data: it goes to KMS as the digest.
      expect(calls.at(-1)!.body).toMatchObject({ digest: { sha256: toBase64(fromHex(txId)) } });
    }
  });

  it("asks again when a signature is corrupted in transit, and never uses a bad one", async () => {
    const once = fakeKms({ flipSignature: 1 });
    const signer = await gcpKmsEd25519Signer(once.client, ED_KEY);
    await expect(signer.signMessage(utf8("m"))).resolves.toHaveLength(64);
    expect(once.calls.filter((c) => c.url.endsWith(":asymmetricSign"))).toHaveLength(2);
    const always = await gcpKmsEd25519Signer(fakeKms({ flipSignature: 99 }).client, ED_KEY);
    await expect(always.signMessage(utf8("m"))).rejects.toThrow(/integrity/);
    const unverified = await gcpKmsTronSigner(fakeKms({ unverified: true }).client, K1_KEY);
    await expect(unverified.signTransactionId("11".repeat(32))).rejects.toThrow(/integrity/);
    const other = await gcpKmsTronSigner(fakeKms({ wrongName: true }).client, K1_KEY);
    await expect(other.signTransactionId("11".repeat(32))).rejects.toThrow(/different key version/);
  });

  it("refuses a key of the wrong kind", async () => {
    const { client } = fakeKms();
    await expect(gcpKmsTronSigner(client, ED_KEY)).rejects.toThrow(/not EC_SIGN_SECP256K1_SHA256/);
    await expect(gcpKmsEd25519Signer(client, K1_KEY)).rejects.toThrow(/not EC_SIGN_ED25519/);
  });

  it("parses strict DER only", () => {
    const sig = secp256k1.sign(new Uint8Array(32).fill(1), k1Secret);
    expect(parseDerSignature(sig.toDERRawBytes())).toEqual({ r: sig.r, s: sig.s });
    expect(() => parseDerSignature(concatBytes(sig.toDERRawBytes(), Uint8Array.of(0)))).toThrow(/DER/);
    expect(() => parseDerSignature(sig.toCompactRawBytes())).toThrow(/DER/);
  });
});

describe("service account sign-in", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyJson = JSON.stringify({ type: "service_account", client_email: "signer@farm-rwa.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });

  it("exchanges a signed JWT for a token and reuses it until shortly before expiry", async () => {
    let now = 1_800_000_000_000;
    const posts: URLSearchParams[] = [];
    const auth = serviceAccountAuth(
      parseServiceAccountKey(keyJson),
      async (url, init) => {
        expect(url).toBe("https://oauth2.googleapis.com/token");
        posts.push(new URLSearchParams(init.body));
        return { ok: true, status: 200, json: async () => ({ access_token: `t${posts.length}`, expires_in: 3600 }), text: async () => "" };
      },
      () => now,
    );
    expect(await auth.token()).toBe("t1");
    now += 3_000_000;
    expect(await auth.token()).toBe("t1");
    now += 600_000;
    expect(await auth.token()).toBe("t2");
    const [header, claims, signature] = posts[0]!.get("assertion")!.split(".");
    expect(posts[0]!.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({
      iss: "signer@farm-rwa.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/cloudkms",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    expect(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("refuses anything that is not a service account key", () => {
    expect(() => parseServiceAccountKey("{")).toThrow(/not valid JSON/);
    expect(() => parseServiceAccountKey(JSON.stringify({ type: "authorized_user", client_email: "a", private_key: "x" }))).toThrow(/not a service account key/);
  });
});
