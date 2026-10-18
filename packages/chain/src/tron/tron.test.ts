/** TRON addresses, ABI, protobuf checks, settlement and observation against a simulated node. */
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { describe, expect, it } from "vitest";
import type { TronSigner } from "@metafarm/domain";
import { concatBytes, fromHex, toHex, utf8 } from "../bytes";
import { decodeUint256, encodeTransferParams, transferCallData } from "./abi";
import { isTronAddress, recoverTronSigner, tronAddressBytes, tronAddressFromHex, tronAddressOfPublicKey, tronAddressToHex } from "./address";
import type { TronHttp } from "./http";
import { TronObservationAdapter, TronSubmitError } from "./observation-adapter";
import { decodeRawTransaction, decodeTriggerSmartContract } from "./protobuf";
import { InsufficientTokenBalanceError, TronSettlementAdapter, feeLimitFor } from "./settlement-adapter";

const ZERO = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const keyOf = (n: number) => {
  const priv = new Uint8Array(32);
  priv[31] = n;
  return priv;
};
const addressOf = (priv: Uint8Array) => tronAddressOfPublicKey(secp256k1.getPublicKey(priv, false));
const signerFor = (priv: Uint8Array): TronSigner => ({
  address: addressOf(priv),
  signTransactionId: async (txId) => {
    const sig = secp256k1.sign(fromHex(txId), priv);
    return toHex(concatBytes(sig.toCompactRawBytes(), Uint8Array.of(27 + sig.recovery)));
  },
});

// ── A minimal protobuf writer, playing the node ──
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
function rawTransfer(o: { owner: string; contract: string; data: string; feeLimit: bigint; expiration: bigint; callValue?: bigint }) {
  const trigger = concatBytes(
    pbBytes(1, tronAddressBytes(o.owner)),
    pbBytes(2, tronAddressBytes(o.contract)),
    ...(o.callValue ? [pbInt(3, o.callValue)] : []),
    pbBytes(4, fromHex(o.data)),
  );
  const any = concatBytes(pbBytes(1, utf8("type.googleapis.com/protocol.TriggerSmartContract")), pbBytes(2, trigger));
  return concatBytes(pbBytes(1, fromHex("ab12")), pbBytes(4, fromHex("0011223344556677")), pbInt(8, o.expiration), pbBytes(11, concatBytes(pbInt(1, 31n), pbBytes(2, any))), pbInt(14, o.expiration - 60_000n), pbInt(18, o.feeLimit));
}

const NOW = new Date("2026-10-18T06:00:00Z");
const sender = keyOf(1);
const from = addressOf(sender);
const to = addressOf(keyOf(2));

function fakeNode(o: { balance?: bigint; tamper?: (req: Record<string, unknown>) => Partial<Parameters<typeof rawTransfer>[0]>; badTxId?: boolean; simFails?: boolean; broadcast?: object; infos?: Record<string, object>; solidTime?: number } = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const http: TronHttp = {
    async post<T>(path: string, body: Record<string, unknown>) {
      calls.push({ path, body });
      const reply = (x: unknown) => x as T;
      if (path === "/wallet/triggerconstantcontract" && body.function_selector === "balanceOf(address)") return reply({ result: { result: true }, constant_result: [(o.balance ?? 10_000_000n).toString(16).padStart(64, "0")] });
      if (path === "/wallet/triggerconstantcontract")
        return reply(o.simFails ? { result: { result: false, message: Buffer.from("REVERT opcode executed").toString("hex") } } : { result: { result: true }, energy_used: 14_000, constant_result: ["1".padStart(64, "0")] });
      if (path === "/wallet/getchainparameters") return reply({ chainParameter: [{ key: "getTransactionFee", value: 1000 }, { key: "getEnergyFee", value: 210 }] });
      if (path === "/wallet/triggersmartcontract") {
        const honest = { owner: from, contract: USDT, data: `a9059cbb${body.parameter as string}`, feeLimit: BigInt(body.fee_limit as number), expiration: BigInt(NOW.getTime() + 60_000) };
        const raw = rawTransfer({ ...honest, ...(o.tamper?.(body) ?? {}) });
        const txID = o.badTxId ? "00".repeat(32) : toHex(sha256(raw));
        return reply({ result: { result: true }, transaction: { txID, raw_data: {}, raw_data_hex: toHex(raw), visible: true } });
      }
      if (path === "/wallet/broadcasttransaction") return reply(o.broadcast ?? { result: true, txid: body.txID });
      if (path.endsWith("/gettransactioninfobyid")) return reply(o.infos?.[path] ?? {});
      if (path === "/walletsolidity/getnowblock") return reply({ block_header: { raw_data: { number: 900, timestamp: o.solidTime ?? NOW.getTime() } } });
      if (path === "/wallet/getnowblock") return reply({ block_header: { raw_data: { number: 905, timestamp: NOW.getTime() } } });
      throw new Error(`unexpected ${path}`);
    },
  };
  return { http, calls };
}

const adapterOn = (node: ReturnType<typeof fakeNode>, signer = signerFor(sender)) =>
  new TronSettlementAdapter({ network: "tron-nile", http: node.http, signer, mainnetEnabled: false, now: () => NOW });
const transfer = { network: "tron-nile" as const, tokenContract: USDT, from, to, amount: 2_500_000n };

describe("TRON addresses and signatures", () => {
  it("converts well-known addresses", () => {
    expect(tronAddressToHex(ZERO)).toBe("41" + "00".repeat(20));
    expect(tronAddressToHex(USDT)).toBe("41a614f803b6fd780986a42c78ec9c7f77e6ded13c");
    expect(tronAddressFromHex("41a614f803b6fd780986a42c78ec9c7f77e6ded13c")).toBe(USDT);
    expect(isTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toBe(false);
    expect(isTronAddress("11111111111111111111111111111111")).toBe(false);
  });

  it("derives the account id like Ethereum, and recovers the signer", async () => {
    // Private key 1 is Ethereum's 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf.
    expect(tronAddressToHex(addressOf(keyOf(1)))).toBe("417e5f4552091a69125d5dfcb7b8c2659029395bdf");
    const txId = toHex(sha256(utf8("tx")));
    expect(recoverTronSigner(txId, await signerFor(sender).signTransactionId(txId))).toBe(from);
    expect(recoverTronSigner(txId, await signerFor(keyOf(3)).signTransactionId(txId))).not.toBe(from);
  });
});

describe("TRC-20 ABI and protobuf", () => {
  it("encodes transfer like Ethereum ABI", () => {
    const data = transferCallData(USDT, 1_000_000n);
    expect(data).toBe(`a9059cbb${"0".repeat(24)}a614f803b6fd780986a42c78ec9c7f77e6ded13c${(1_000_000).toString(16).padStart(64, "0")}`);
    expect(encodeTransferParams(USDT, 1n)).toHaveLength(128);
    expect(decodeUint256("1".padStart(64, "0"))).toBe(1n);
  });

  it("reads the fields we check from a raw transaction", () => {
    const raw = rawTransfer({ owner: from, contract: USDT, data: transferCallData(to, 5n), feeLimit: 3_528_000n, expiration: 1_792_000_000_000n });
    const tx = decodeRawTransaction(raw);
    expect(tx).toMatchObject({ expiration: 1_792_000_000_000n, feeLimit: 3_528_000n });
    expect(tx.contracts).toHaveLength(1);
    expect(tx.contracts[0]).toMatchObject({ type: 31, typeUrl: "type.googleapis.com/protocol.TriggerSmartContract" });
    const call = decodeTriggerSmartContract(tx.contracts[0]!.value);
    expect(toHex(call.owner)).toBe(tronAddressToHex(from));
    expect(toHex(call.data)).toBe(transferCallData(to, 5n));
    expect(call.callValue).toBe(0n);
  });
});

describe("TRON settlement adapter", () => {
  it("sets the fee limit from simulated energy and the chain's energy price", () => {
    expect(feeLimitFor(14_000n, 210n, 20, 100_000_000n)).toBe(3_528_000n);
    expect(() => feeLimitFor(1_000_000n, 420n, 20, 100_000_000n)).toThrow(/above the/);
  });

  it("refuses mainnet until enabled and other rails", () => {
    const { http } = fakeNode();
    expect(() => new TronSettlementAdapter({ network: "tron-mainnet", http, signer: signerFor(sender), mainnetEnabled: false })).toThrow(/not enabled/);
    expect(() => new TronSettlementAdapter({ network: "solana-devnet", http, signer: signerFor(sender), mainnetEnabled: true })).toThrow(/not a TRON network/);
  });

  it("prepares a checked, signed transfer", async () => {
    const node = fakeNode();
    const p = await adapterOn(node).prepareTransfer(transfer);
    const wire = JSON.parse(p.wire) as { txID: string; raw_data_hex: string; signature: string[] };
    expect(p.txRef).toBe(wire.txID);
    expect(toHex(sha256(fromHex(wire.raw_data_hex)))).toBe(wire.txID);
    expect(recoverTronSigner(wire.txID, wire.signature[0]!)).toBe(from);
    expect(p.fees).toMatchObject({ feeLimitSun: 3_528_000n, estimatedEnergy: 14_000n });
    expect(p.validity.expiresAt).toEqual(new Date(NOW.getTime() + 60_000));
    const built = node.calls.find((c) => c.path === "/wallet/triggersmartcontract")!.body;
    expect(built).toMatchObject({ owner_address: from, contract_address: USDT, fee_limit: 3_528_000, call_value: 0, visible: true });
  });

  it("refuses transactions the node changed, whatever the field", async () => {
    const other = addressOf(keyOf(9));
    const cases: [string, ReturnType<typeof fakeNode>][] = [
      ["recipient or amount", fakeNode({ tamper: () => ({ data: transferCallData(other, 2_500_000n) }) })],
      ["contract", fakeNode({ tamper: () => ({ contract: ZERO }) })],
      ["sender", fakeNode({ tamper: () => ({ owner: other }) })],
      ["fee limit", fakeNode({ tamper: () => ({ feeLimit: 999_000_000n }) })],
      ["sends TRX", fakeNode({ tamper: () => ({ callValue: 1n }) })],
      ["expiration", fakeNode({ tamper: () => ({ expiration: BigInt(NOW.getTime() + 3 * 86_400_000) }) })],
      ["transaction id", fakeNode({ badTxId: true })],
    ];
    for (const [what, node] of cases) {
      await expect(adapterOn(node).prepareTransfer(transfer), what).rejects.toThrow();
      expect(node.calls.some((c) => c.path === "/wallet/broadcasttransaction"), what).toBe(false);
    }
  });

  it("checks balance, simulation and the signer before anything is signed", async () => {
    await expect(adapterOn(fakeNode({ balance: 1n })).prepareTransfer(transfer)).rejects.toBeInstanceOf(InsufficientTokenBalanceError);
    await expect(adapterOn(fakeNode({ simFails: true })).prepareTransfer(transfer)).rejects.toThrow(/REVERT opcode executed/);
    // A signer whose key is not the sender's.
    const impostor = { ...signerFor(keyOf(7)), address: from };
    await expect(adapterOn(fakeNode(), impostor).prepareTransfer(transfer)).rejects.toThrow(/did not sign as the sender/);
    await expect(adapterOn(fakeNode()).prepareTransfer({ ...transfer, from: to })).rejects.toThrow(/signer must be the sender/);
    await expect(adapterOn(fakeNode()).prepareTransfer({ ...transfer, to: "not-an-address" })).rejects.toThrow(/not a TRON address/);
  });
});

describe("TRON observation adapter", () => {
  const prepared = { network: "tron-nile" as const, txRef: "ab".repeat(32), wire: JSON.stringify({ txID: "ab".repeat(32) }), validity: {}, fees: {}, summary: {} };
  const target = { network: "tron-nile" as const, txRef: prepared.txRef, expiresAt: new Date(NOW.getTime() + 60_000) };
  const observe = (o: Parameters<typeof fakeNode>[0]) => new TronObservationAdapter({ network: "tron-nile", http: fakeNode(o).http }).observe(target);

  it("is final only once solidified, failed when the receipt says so", async () => {
    expect(await observe({ infos: { "/walletsolidity/gettransactioninfobyid": { id: "x", blockNumber: 880, fee: 1_345_000, receipt: { result: "SUCCESS" } } } })).toEqual({
      status: "final",
      slotOrBlock: 880n,
      feePaid: 1_345_000n,
    });
    const failed = await observe({ infos: { "/walletsolidity/gettransactioninfobyid": { id: "x", blockNumber: 880, result: "FAILED", receipt: { result: "OUT_OF_ENERGY" } } } });
    expect(failed).toMatchObject({ status: "failed", error: "OUT_OF_ENERGY" });
    expect(await observe({ infos: { "/wallet/gettransactioninfobyid": { id: "x", blockNumber: 902 } } })).toEqual({ status: "observed", slotOrBlock: 902n, confirmations: 3 });
  });

  it("calls a missing transaction pending until the solidified chain is past its expiration", async () => {
    expect(await observe({})).toEqual({ status: "pending" });
    expect(await observe({ solidTime: NOW.getTime() + 120_000 })).toEqual({ status: "expired" });
  });

  it("re-sends safely and tells definitive refusals apart", async () => {
    const send = (broadcast: object) => new TronObservationAdapter({ network: "tron-nile", http: fakeNode({ broadcast }).http }).submit(prepared);
    await expect(send({ result: true })).resolves.toBeUndefined();
    await expect(send({ code: "DUP_TRANSACTION_ERROR" })).resolves.toBeUndefined();
    await expect(send({ code: "SIGERROR", message: Buffer.from("validate signature error").toString("hex") })).rejects.toMatchObject({ definitive: true, message: "SIGERROR: validate signature error" });
    await expect(send({ code: "SERVER_BUSY" })).rejects.toMatchObject({ definitive: false });
    await expect(send({ code: "SERVER_BUSY" })).rejects.toBeInstanceOf(TronSubmitError);
  });
});
