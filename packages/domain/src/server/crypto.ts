import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 32-character alphanumeric nonce suitable for EIP-4361 messages. */
export function generateNonce(length = 32): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(length);
  let out = "";
  // 256 % 62 != 0; reject the biased tail to keep the distribution uniform.
  for (let i = 0; out.length < length; i++) {
    if (i >= bytes.length) return out + generateNonce(length - out.length);
    const b = bytes[i]!;
    if (b < 248) out += alphabet[b % 62];
  }
  return out;
}

/** Hash used for duplicate-boundary detection; see canonicalGeometryKey. */
export function geometryHash(canonicalKey: string): string {
  return sha256Hex(`geom:v1:${canonicalKey}`);
}
