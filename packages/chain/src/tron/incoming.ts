/**
 * Verifying a TRC-20 payment someone else sent (an investor's subscription). Accepted only when
 * the solidified chain shows exactly the expected transfer: the call itself, a successful receipt,
 * and the token's Transfer event with the same sender, recipient and amount.
 */
import { sha256 } from "@noble/hashes/sha2";
import { fromHex, toHex } from "../bytes";
import { SELECTOR } from "./abi";
import { tronAddressBytes, tronAddressFromHex } from "./address";
import type { TronHttp } from "./http";
import { TRIGGER_SMART_CONTRACT, decodeRawTransaction, decodeTriggerSmartContract } from "./protobuf";

/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_EVENT_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ExpectedTransfer {
  tokenContract: string;
  from: string;
  to: string;
  amount: bigint;
}

export type IncomingCheck =
  | { ok: true; block: bigint; timestamp: Date; amount: bigint }
  | { ok: false; reason: "not_solidified" | "not_a_transfer" | "failed" | "mismatch" | "no_transfer_event" | "malformed"; detail?: string };

interface SolidTx {
  txID?: string;
  raw_data_hex?: string;
  ret?: { contractRet?: string }[];
}
interface SolidInfo {
  id?: string;
  blockNumber?: number;
  blockTimeStamp?: number;
  receipt?: { result?: string };
  log?: { address?: string; topics?: string[]; data?: string }[];
}

const word = (hex: string, i: number) => hex.slice(i * 64, (i + 1) * 64);
const addressFromWord = (w: string) => tronAddressFromHex(`41${w.slice(24)}`);

export async function verifyIncomingTrc20(http: TronHttp, txId: string, expected: ExpectedTransfer): Promise<IncomingCheck> {
  if (!/^[0-9a-f]{64}$/i.test(txId)) return { ok: false, reason: "malformed", detail: "a TRON transaction id is 64 hex characters" };
  const id = txId.toLowerCase();
  const [tx, info] = await Promise.all([
    http.post<SolidTx>("/walletsolidity/gettransactionbyid", { value: id }),
    http.post<SolidInfo>("/walletsolidity/gettransactioninfobyid", { value: id }),
  ]);
  if (!tx.txID || !tx.raw_data_hex || !info.id) return { ok: false, reason: "not_solidified" };

  const raw = fromHex(tx.raw_data_hex);
  if (toHex(sha256(raw)) !== id) return { ok: false, reason: "malformed", detail: "transaction id does not match its contents" };
  const decoded = decodeRawTransaction(raw);
  if (decoded.contracts.length !== 1 || decoded.contracts[0]!.type !== TRIGGER_SMART_CONTRACT) return { ok: false, reason: "not_a_transfer" };
  const call = decodeTriggerSmartContract(decoded.contracts[0]!.value);
  const data = toHex(call.data);
  if (!data.startsWith(SELECTOR.transfer) || data.length !== 8 + 128) return { ok: false, reason: "not_a_transfer" };

  if (tx.ret?.[0]?.contractRet !== "SUCCESS" || info.receipt?.result !== "SUCCESS") {
    return { ok: false, reason: "failed", detail: info.receipt?.result ?? tx.ret?.[0]?.contractRet };
  }

  const args = data.slice(8);
  const callTo = addressFromWord(word(args, 0));
  const callAmount = BigInt(`0x${word(args, 1)}`);
  const callFrom = tronAddressFromHex(toHex(call.owner));
  const callContract = tronAddressFromHex(toHex(call.contract));
  const mismatches = [
    callContract !== expected.tokenContract && "token contract",
    callFrom !== expected.from && "sender",
    callTo !== expected.to && "recipient",
    callAmount !== expected.amount && "amount",
  ].filter(Boolean);
  if (mismatches.length) return { ok: false, reason: "mismatch", detail: mismatches.join(", ") };

  // The token itself must report the movement.
  const contractHex = toHex(tronAddressBytes(expected.tokenContract)).slice(2);
  const event = (info.log ?? []).find(
    (l) =>
      l.address?.toLowerCase() === contractHex &&
      l.topics?.[0]?.toLowerCase() === TRANSFER_EVENT_TOPIC &&
      l.topics.length === 3 &&
      addressFromWord(l.topics[1]!.toLowerCase()) === expected.from &&
      addressFromWord(l.topics[2]!.toLowerCase()) === expected.to &&
      l.data !== undefined &&
      BigInt(`0x${l.data}`) === expected.amount,
  );
  if (!event) return { ok: false, reason: "no_transfer_event" };
  return { ok: true, block: BigInt(info.blockNumber ?? 0), timestamp: new Date(info.blockTimeStamp ?? 0), amount: callAmount };
}
