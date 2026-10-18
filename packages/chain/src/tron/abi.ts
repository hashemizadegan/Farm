/** TRC-20 calls, ABI-encoded as on Ethereum (addresses without the 41 prefix). */
import { concatBytes, fromHex, toHex } from "../bytes";
import { tronAddressBytes } from "./address";

export const UINT256_MAX = (1n << 256n) - 1n;
export const SELECTOR = { transfer: "a9059cbb", balanceOf: "70a08231" } as const;

const word = (n: bigint) => {
  if (n < 0n || n > UINT256_MAX) throw new RangeError("does not fit in uint256");
  return fromHex(n.toString(16).padStart(64, "0"));
};
const addressWord = (address: string) => concatBytes(new Uint8Array(12), tronAddressBytes(address).subarray(1));

/** Parameters only (what the TRON API calls `parameter`). */
export const encodeTransferParams = (to: string, amount: bigint) => toHex(concatBytes(addressWord(to), word(amount)));
export const encodeBalanceOfParams = (owner: string) => toHex(addressWord(owner));
/** Full call data as it appears inside the transaction. */
export const transferCallData = (to: string, amount: bigint) => `${SELECTOR.transfer}${encodeTransferParams(to, amount)}`;

export function decodeUint256(hex: string): bigint {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("expected one 32-byte word");
  return BigInt(`0x${hex}`);
}
