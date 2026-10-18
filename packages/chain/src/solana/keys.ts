/** Solana addresses, program-derived addresses and well-known program ids. */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes, utf8 } from "../bytes";
import { base58Decode, base58Encode } from "./base58";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PQnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

export function addressBytes(address: string): Uint8Array {
  const b = base58Decode(address);
  if (b.length !== 32) throw new Error(`not a Solana address: ${address}`);
  return b;
}

export function isSolanaAddress(address: string): boolean {
  try {
    addressBytes(address);
    return true;
  } catch {
    return false;
  }
}

export function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/** The program-derived address for these seeds: the first bump (from 255 down) that is off the curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): [string, number] {
  if (seeds.length > 15 || seeds.some((s) => s.length > 32)) throw new Error("too many or too long seeds");
  const program = addressBytes(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(concatBytes(...seeds, Uint8Array.of(bump), program, utf8("ProgramDerivedAddress")));
    if (!isOnCurve(hash)) return [base58Encode(hash), bump];
  }
  throw new Error("no program address found");
}

/** A holder's associated token account for a mint (Token-2022 by default). */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram = TOKEN_2022_PROGRAM): string {
  return findProgramAddress([addressBytes(owner), addressBytes(tokenProgram), addressBytes(mint)], ASSOCIATED_TOKEN_PROGRAM)[0];
}

/** A new keypair, for accounts that must sign once at creation (a mint). The secret never leaves memory. */
export function ephemeralKeypair(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const secret = random(32);
  const address = base58Encode(ed25519.getPublicKey(secret));
  return { address, sign: async (message: Uint8Array) => ed25519.sign(message, secret) };
}
