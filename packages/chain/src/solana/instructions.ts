/**
 * Instruction builders for the System, Compute Budget, Associated Token and Token-2022 programs.
 * Layouts follow the programs' own instruction encodings (checked byte-for-byte against
 * @solana/spl-token and @solana/web3.js in the tests).
 */
import { concatBytes, u16le, u32le, u64le } from "../bytes";
import type { Instruction } from "./codec";
import { ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, addressBytes } from "./keys";

const ZERO_KEY = new Uint8Array(32);
// Optional keys as the programs parse them: tag 1 + key, or the tag 0 alone. (Padding an absent key
// would shift the next field: in InitializeTransferFeeConfig two options follow each other.)
const optionKey = (k: string | null | undefined) => (k ? concatBytes(Uint8Array.of(1), addressBytes(k)) : Uint8Array.of(0));

// ── System and compute budget ──────────────────────────────────────────

export function createAccount(p: { from: string; newAccount: string; lamports: bigint; space: number; owner: string }): Instruction {
  return {
    programId: SYSTEM_PROGRAM,
    accounts: [
      { address: p.from, signer: true, writable: true },
      { address: p.newAccount, signer: true, writable: true },
    ],
    data: concatBytes(u32le(0), u64le(p.lamports), u64le(BigInt(p.space)), addressBytes(p.owner)),
  };
}

export function setComputeUnitLimit(units: number): Instruction {
  return { programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: concatBytes(Uint8Array.of(2), u32le(units)) };
}

export function setComputeUnitPrice(microLamports: bigint): Instruction {
  return { programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: concatBytes(Uint8Array.of(3), u64le(microLamports)) };
}

// ── Associated token accounts ──────────────────────────────────────────

export function createAssociatedTokenAccountIdempotent(p: { payer: string; ata: string; owner: string; mint: string }): Instruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [
      { address: p.payer, signer: true, writable: true },
      { address: p.ata, signer: false, writable: true },
      { address: p.owner, signer: false, writable: false },
      { address: p.mint, signer: false, writable: false },
      { address: SYSTEM_PROGRAM, signer: false, writable: false },
      { address: TOKEN_2022_PROGRAM, signer: false, writable: false },
    ],
    data: Uint8Array.of(1),
  };
}

// ── Token-2022 ─────────────────────────────────────────────────────────

const mintOnly = (mint: string) => [{ address: mint, signer: false, writable: true }];

export function initializeMint2(p: { mint: string; decimals: number; mintAuthority: string; freezeAuthority: string | null }): Instruction {
  if (!Number.isInteger(p.decimals) || p.decimals < 0 || p.decimals > 9) throw new RangeError("decimals must be 0–9");
  return {
    programId: TOKEN_2022_PROGRAM,
    accounts: mintOnly(p.mint),
    data: concatBytes(Uint8Array.of(20, p.decimals), addressBytes(p.mintAuthority), optionKey(p.freezeAuthority)),
  };
}

export function initializeTransferFeeConfig(p: { mint: string; configAuthority: string | null; withdrawAuthority: string | null; basisPoints: number; maximumFee: bigint }): Instruction {
  if (!Number.isInteger(p.basisPoints) || p.basisPoints < 0 || p.basisPoints > 10_000) throw new RangeError("basis points must be 0–10000");
  return {
    programId: TOKEN_2022_PROGRAM,
    accounts: mintOnly(p.mint),
    data: concatBytes(Uint8Array.of(26, 0), optionKey(p.configAuthority), optionKey(p.withdrawAuthority), u16le(p.basisPoints), u64le(p.maximumFee)),
  };
}

export function initializePermanentDelegate(p: { mint: string; delegate: string }): Instruction {
  return { programId: TOKEN_2022_PROGRAM, accounts: mintOnly(p.mint), data: concatBytes(Uint8Array.of(35), addressBytes(p.delegate)) };
}

export function initializeTransferHook(p: { mint: string; authority: string | null; programId: string }): Instruction {
  return {
    programId: TOKEN_2022_PROGRAM,
    accounts: mintOnly(p.mint),
    data: concatBytes(Uint8Array.of(36, 0), p.authority ? addressBytes(p.authority) : ZERO_KEY, addressBytes(p.programId)),
  };
}

export function mintToChecked(p: { mint: string; destination: string; authority: string; amount: bigint; decimals: number }): Instruction {
  return {
    programId: TOKEN_2022_PROGRAM,
    accounts: [
      { address: p.mint, signer: false, writable: true },
      { address: p.destination, signer: false, writable: true },
      { address: p.authority, signer: true, writable: false },
    ],
    data: concatBytes(Uint8Array.of(14), u64le(p.amount), Uint8Array.of(p.decimals)),
  };
}

export function burnChecked(p: { account: string; mint: string; authority: string; amount: bigint; decimals: number }): Instruction {
  return {
    programId: TOKEN_2022_PROGRAM,
    accounts: [
      { address: p.account, signer: false, writable: true },
      { address: p.mint, signer: false, writable: true },
      { address: p.authority, signer: true, writable: false },
    ],
    data: concatBytes(Uint8Array.of(15), u64le(p.amount), Uint8Array.of(p.decimals)),
  };
}

function freezeOrThaw(code: 10 | 11, p: { account: string; mint: string; authority: string }): Instruction {
  return {
    programId: TOKEN_2022_PROGRAM,
    accounts: [
      { address: p.account, signer: false, writable: true },
      { address: p.mint, signer: false, writable: false },
      { address: p.authority, signer: true, writable: false },
    ],
    data: Uint8Array.of(code),
  };
}
export const freezeAccount = (p: { account: string; mint: string; authority: string }) => freezeOrThaw(10, p);
export const thawAccount = (p: { account: string; mint: string; authority: string }) => freezeOrThaw(11, p);

/** Mint extensions this adapter can set up, with their data sizes. */
export const MINT_EXTENSIONS = { transferFeeConfig: 108, permanentDelegate: 32, transferHook: 64 } as const;
export type MintExtension = keyof typeof MINT_EXTENSIONS;

/** Bytes a Token-2022 mint account needs with these extensions. */
export function mintLength(extensions: MintExtension[]): number {
  if (extensions.length === 0) return 82;
  // Base account size, account-type byte, then type-length-value entries.
  const length = 165 + 1 + extensions.reduce((n, e) => n + 4 + MINT_EXTENSIONS[e], 0);
  // A mint must never be mistaken for a multisig account.
  return length === 355 ? length + 2 : length;
}
