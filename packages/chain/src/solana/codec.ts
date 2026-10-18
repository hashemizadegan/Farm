/** Legacy Solana transaction messages: compile, sign, serialize. */
import { concatBytes } from "../bytes";
import { base58Encode } from "./base58";
import { addressBytes } from "./keys";

export interface AccountMeta {
  address: string;
  signer: boolean;
  writable: boolean;
}

export interface Instruction {
  programId: string;
  accounts: AccountMeta[];
  data: Uint8Array;
}

export function compactU16(n: number): Uint8Array {
  if (n < 0 || n > 0xffff) throw new RangeError("compact-u16 out of range");
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return Uint8Array.from(out);
    }
    out.push(b | 0x80);
  }
}

export interface CompiledMessage {
  message: Uint8Array;
  /** Addresses that must sign, in signature order (fee payer first). */
  signers: string[];
  accountKeys: string[];
}

/**
 * Orders accounts as the runtime requires: fee payer, writable signers, read-only signers,
 * writable non-signers, read-only non-signers; first appearance breaks ties.
 */
export function compileMessage(feePayer: string, recentBlockhash: string, instructions: Instruction[]): CompiledMessage {
  const metas = new Map<string, { signer: boolean; writable: boolean }>();
  const add = (address: string, signer: boolean, writable: boolean) => {
    const m = metas.get(address);
    metas.set(address, { signer: (m?.signer ?? false) || signer, writable: (m?.writable ?? false) || writable });
  };
  add(feePayer, true, true);
  for (const ix of instructions) {
    for (const a of ix.accounts) add(a.address, a.signer, a.writable);
    add(ix.programId, false, false);
  }
  const rank = (address: string, m: { signer: boolean; writable: boolean }) =>
    address === feePayer ? 0 : m.signer ? (m.writable ? 1 : 2) : m.writable ? 3 : 4;
  const ordered = [...metas.entries()].sort((a, b) => rank(...a) - rank(...b));
  const accountKeys = ordered.map(([a]) => a);
  const index = new Map(accountKeys.map((a, i) => [a, i]));
  const signers = ordered.filter(([, m]) => m.signer).map(([a]) => a);
  const readonlySigned = ordered.filter(([, m]) => m.signer && !m.writable).length;
  const readonlyUnsigned = ordered.filter(([, m]) => !m.signer && !m.writable).length;
  if (accountKeys.length > 256) throw new Error("too many accounts for one transaction");

  const parts: Uint8Array[] = [Uint8Array.of(signers.length, readonlySigned, readonlyUnsigned), compactU16(accountKeys.length)];
  for (const a of accountKeys) parts.push(addressBytes(a));
  parts.push(addressBytes(recentBlockhash), compactU16(instructions.length));
  for (const ix of instructions) {
    parts.push(Uint8Array.of(index.get(ix.programId)!), compactU16(ix.accounts.length), Uint8Array.from(ix.accounts.map((a) => index.get(a.address)!)));
    parts.push(compactU16(ix.data.length), ix.data);
  }
  return { message: concatBytes(...parts), signers, accountKeys };
}

export type SignFn = (message: Uint8Array) => Promise<Uint8Array>;

/** Signs with every required signer and returns the wire bytes and the transaction's signature (its id). */
export async function signAndSerialize(compiled: CompiledMessage, signers: Map<string, SignFn>): Promise<{ wire: Uint8Array; signature: string }> {
  const sigs: Uint8Array[] = [];
  for (const address of compiled.signers) {
    const sign = signers.get(address);
    if (!sign) throw new Error(`missing signer ${address}`);
    const sig = await sign(compiled.message);
    if (sig.length !== 64) throw new Error(`signer ${address} returned a bad signature`);
    sigs.push(sig);
  }
  const wire = concatBytes(compactU16(sigs.length), ...sigs, compiled.message);
  if (wire.length > 1232) throw new Error(`transaction is ${wire.length} bytes; the limit is 1232`);
  return { wire, signature: base58Encode(sigs[0]!) };
}
