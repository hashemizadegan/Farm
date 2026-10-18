/** TRON addresses: base58check of 0x41 followed by the 20-byte account id. */
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes, fromHex, toHex } from "../bytes";
import { base58Decode, base58Encode } from "../solana/base58";

const checksum = (payload: Uint8Array) => sha256(sha256(payload)).subarray(0, 4);

export function tronAddressBytes(address: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = base58Decode(address);
  } catch {
    throw new Error(`not a TRON address: ${address}`);
  }
  if (raw.length !== 25) throw new Error(`not a TRON address: ${address}`);
  const payload = raw.subarray(0, 21);
  if (payload[0] !== 0x41 || toHex(checksum(payload)) !== toHex(raw.subarray(21))) throw new Error(`not a TRON address: ${address}`);
  return payload;
}

export function isTronAddress(address: string): boolean {
  try {
    tronAddressBytes(address);
    return true;
  } catch {
    return false;
  }
}

/** From the 21-byte form (hex, with the 41 prefix). */
export function tronAddressFromHex(hex: string): string {
  const payload = fromHex(hex);
  if (payload.length !== 21 || payload[0] !== 0x41) throw new Error(`not a TRON hex address: ${hex}`);
  return base58Encode(concatBytes(payload, checksum(payload)));
}

export const tronAddressToHex = (address: string) => toHex(tronAddressBytes(address));

/** The TRON address of a secp256k1 public key (65-byte uncompressed). */
export function tronAddressOfPublicKey(uncompressed: Uint8Array): string {
  const id = keccak_256(uncompressed.subarray(1)).subarray(12);
  return tronAddressFromHex(`41${toHex(id)}`);
}

/**
 * Who signed this transaction id: recovers the key from a 65-byte r‖s‖v signature
 * (v as 0/1 or 27/28) and returns its TRON address.
 */
export function recoverTronSigner(txIdHex: string, signatureHex: string): string {
  const sig = fromHex(signatureHex);
  if (sig.length !== 65) throw new Error("a TRON signature is 65 bytes");
  const v = sig[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new Error("bad recovery id");
  const point = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(recovery).recoverPublicKey(fromHex(txIdHex));
  return tronAddressOfPublicKey(point.toRawBytes(false));
}
