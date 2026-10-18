/** Reading a Token-2022 mint account (the base Mint layout that precedes any extensions). */
import { base58Encode } from "./base58";

export interface MintAccount {
  mintAuthority: string | null;
  supply: bigint;
  decimals: number;
  initialized: boolean;
  freezeAuthority: string | null;
}

export function parseMintAccount(data: Uint8Array): MintAccount {
  if (data.length < 82) throw new Error("not a mint account");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const option = (at: number) => (view.getUint32(at, true) === 1 ? base58Encode(data.subarray(at + 4, at + 36)) : null);
  return {
    mintAuthority: option(0),
    supply: view.getBigUint64(36, true),
    decimals: data[44]!,
    initialized: data[45] === 1,
    freezeAuthority: option(46),
  };
}
