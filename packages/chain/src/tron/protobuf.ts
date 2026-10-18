/**
 * Just enough protobuf to read a TRON transaction's raw_data and check it before signing.
 * Field numbers from the TRON protocol (core/Tron.proto, core/contract/smart_contract.proto).
 */

export interface PbField {
  no: number;
  /** 0 = varint, 1 = 64-bit, 2 = length-delimited, 5 = 32-bit. */
  wire: number;
  int?: bigint;
  bytes?: Uint8Array;
}

function varint(buf: Uint8Array, at: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = at; i < buf.length && i < at + 10; i++) {
    const b = buf[i]!;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, i + 1];
    shift += 7n;
  }
  throw new Error("malformed protobuf varint");
}

export function readFields(buf: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let at = 0;
  while (at < buf.length) {
    const [key, next] = varint(buf, at);
    at = next;
    const no = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      const [v, n] = varint(buf, at);
      out.push({ no, wire, int: v });
      at = n;
    } else if (wire === 2) {
      const [len, n] = varint(buf, at);
      const end = n + Number(len);
      if (end > buf.length) throw new Error("malformed protobuf length");
      out.push({ no, wire, bytes: buf.subarray(n, end) });
      at = end;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (at + size > buf.length) throw new Error("malformed protobuf fixed field");
      out.push({ no, wire, bytes: buf.subarray(at, at + size) });
      at += size;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return out;
}

const one = (fields: PbField[], no: number) => fields.filter((f) => f.no === no);

export const TRIGGER_SMART_CONTRACT = 31;

export interface TronRawTransaction {
  refBlockBytes?: Uint8Array;
  refBlockHash?: Uint8Array;
  expiration: bigint;
  timestamp?: bigint;
  feeLimit: bigint;
  memo?: Uint8Array;
  contracts: { type: number; typeUrl: string; value: Uint8Array }[];
}

export function decodeRawTransaction(raw: Uint8Array): TronRawTransaction {
  const f = readFields(raw);
  const contracts = one(f, 11).map((c) => {
    const cf = readFields(c.bytes!);
    const any = readFields(one(cf, 2)[0]?.bytes ?? new Uint8Array());
    return {
      type: Number(one(cf, 1)[0]?.int ?? -1n),
      typeUrl: new TextDecoder().decode(one(any, 1)[0]?.bytes ?? new Uint8Array()),
      value: one(any, 2)[0]?.bytes ?? new Uint8Array(),
    };
  });
  return {
    refBlockBytes: one(f, 1)[0]?.bytes,
    refBlockHash: one(f, 4)[0]?.bytes,
    expiration: one(f, 8)[0]?.int ?? 0n,
    timestamp: one(f, 14)[0]?.int,
    feeLimit: one(f, 18)[0]?.int ?? 0n,
    memo: one(f, 10)[0]?.bytes,
    contracts,
  };
}

export interface TriggerSmartContract {
  owner: Uint8Array;
  contract: Uint8Array;
  callValue: bigint;
  data: Uint8Array;
  callTokenValue: bigint;
}

export function decodeTriggerSmartContract(value: Uint8Array): TriggerSmartContract {
  const f = readFields(value);
  return {
    owner: one(f, 1)[0]?.bytes ?? new Uint8Array(),
    contract: one(f, 2)[0]?.bytes ?? new Uint8Array(),
    callValue: one(f, 3)[0]?.int ?? 0n,
    data: one(f, 4)[0]?.bytes ?? new Uint8Array(),
    callTokenValue: one(f, 5)[0]?.int ?? 0n,
  };
}
