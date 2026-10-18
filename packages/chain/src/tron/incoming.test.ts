import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";
import { describe, expect, it } from "vitest";
import { concatBytes, fromHex, toHex, utf8 } from "../bytes";
import { transferCallData } from "./abi";
import { tronAddressBytes, tronAddressFromHex } from "./address";
import type { TronHttp } from "./http";
import { TRANSFER_EVENT_TOPIC, verifyIncomingTrc20 } from "./incoming";

const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const INVESTOR = tronAddressFromHex(`41${"11".repeat(20)}`);
const TREASURY = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const expected = { tokenContract: USDT, from: INVESTOR, to: TREASURY, amount: 50_000_000n };

const varint = (n: bigint) => {
  const out: number[] = [];
  let v = n;
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Uint8Array.from(out);
};
const pbInt = (no: number, v: bigint) => concatBytes(varint(BigInt(no << 3)), varint(v));
const pbBytes = (no: number, b: Uint8Array) => concatBytes(varint(BigInt((no << 3) | 2)), varint(BigInt(b.length)), b);
function rawTx(owner: string, contract: string, data: string) {
  const trigger = concatBytes(pbBytes(1, tronAddressBytes(owner)), pbBytes(2, tronAddressBytes(contract)), pbBytes(4, fromHex(data)));
  const any = concatBytes(pbBytes(1, utf8("type.googleapis.com/protocol.TriggerSmartContract")), pbBytes(2, trigger));
  return concatBytes(pbInt(8, 1_792_000_000_000n), pbBytes(11, concatBytes(pbInt(1, 31n), pbBytes(2, any))), pbInt(18, 30_000_000n));
}
const word = (addr: string) => "0".repeat(24) + toHex(tronAddressBytes(addr)).slice(2);

function node(o: { to?: string; amount?: bigint; contractRet?: string; logs?: object[] | null; solid?: boolean } = {}) {
  const raw = rawTx(INVESTOR, USDT, transferCallData(o.to ?? TREASURY, o.amount ?? expected.amount));
  const id = toHex(sha256(raw));
  const log = { address: toHex(tronAddressBytes(USDT)).slice(2), topics: [TRANSFER_EVENT_TOPIC, word(INVESTOR), word(o.to ?? TREASURY)], data: (o.amount ?? expected.amount).toString(16).padStart(64, "0") };
  const http: TronHttp = {
    async post<T>(path: string) {
      if (o.solid === false) return {} as T;
      if (path === "/walletsolidity/gettransactionbyid") return { txID: id, raw_data_hex: toHex(raw), ret: [{ contractRet: o.contractRet ?? "SUCCESS" }] } as T;
      return { id, blockNumber: 6_400_000, blockTimeStamp: 1_792_000_000_000, receipt: { result: o.contractRet ?? "SUCCESS" }, log: o.logs === null ? [] : (o.logs ?? [log]) } as T;
    },
  };
  return { http, id };
}

describe("incoming TRC-20 payments", () => {
  it("uses the standard Transfer event topic", () => {
    expect(toHex(keccak_256(utf8("Transfer(address,address,uint256)")))).toBe(TRANSFER_EVENT_TOPIC);
  });

  it("accepts exactly the expected, solidified, successful transfer", async () => {
    const { http, id } = node();
    expect(await verifyIncomingTrc20(http, id, expected)).toEqual({ ok: true, block: 6_400_000n, timestamp: new Date(1_792_000_000_000), amount: 50_000_000n });
  });

  it("refuses anything else", async () => {
    const reason = async (n: ReturnType<typeof node>, e = expected) => {
      const r = await verifyIncomingTrc20(n.http, n.id, e);
      return r.ok ? "ok" : r.reason;
    };
    expect(await reason(node({ solid: false }))).toBe("not_solidified");
    expect(await reason(node({ amount: 49_000_000n }))).toBe("mismatch");
    expect(await reason(node({ to: USDT }))).toBe("mismatch");
    expect(await reason(node(), { ...expected, from: TREASURY })).toBe("mismatch");
    expect(await reason(node({ contractRet: "REVERT" }))).toBe("failed");
    expect(await reason(node({ logs: null }))).toBe("no_transfer_event");
    expect((await verifyIncomingTrc20(node().http, "xyz", expected)).ok).toBe(false);
  });
});
