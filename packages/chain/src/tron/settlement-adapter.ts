/** SettlementPort on TRON: TRC-20 transfers, checked end to end before they are signed. */
import { sha256 } from "@noble/hashes/sha2";
import { networkAllowed, railOf, type Network, type PreparedTransaction, type SettlementPort, type SettlementTransfer, type TronSigner } from "@metafarm/domain";
import { fromHex, toHex } from "../bytes";
import { UINT256_MAX, decodeUint256, encodeBalanceOfParams, encodeTransferParams, transferCallData } from "./abi";
import { isTronAddress, recoverTronSigner, tronAddressBytes } from "./address";
import { tronMessage, type TronHttp } from "./http";
import { TRIGGER_SMART_CONTRACT, decodeRawTransaction, decodeTriggerSmartContract } from "./protobuf";

export interface TronAdapterConfig {
  network: Network;
  http: TronHttp;
  /** Pays energy and bandwidth and signs; must be the transfer's sender. */
  signer: TronSigner;
  mainnetEnabled: boolean;
  /** Most TRX (in sun) a single transfer may burn for energy. */
  maxFeeLimitSun?: bigint;
  /** Headroom over the simulated energy, in percent. */
  energyMarginPercent?: number;
  now?: () => Date;
}

interface TriggerResult {
  result?: { result?: boolean; code?: string; message?: string };
  energy_used?: number;
  energy_penalty?: number;
  constant_result?: string[];
  transaction?: UnsignedTransaction;
}

interface UnsignedTransaction {
  txID: string;
  raw_data: Record<string, unknown>;
  raw_data_hex: string;
  visible?: boolean;
}

export class InsufficientTokenBalanceError extends Error {
  constructor(
    public readonly balance: bigint,
    public readonly needed: bigint,
  ) {
    super(`token balance ${balance} is below the ${needed} to send`);
    this.name = "InsufficientTokenBalanceError";
  }
}

/** Fee limit: simulated energy × energy price × (1 + margin), rounded up, within the cap. */
export function feeLimitFor(energy: bigint, sunPerEnergy: bigint, marginPercent: number, cap: bigint): bigint {
  const raw = energy * sunPerEnergy;
  const withMargin = (raw * BigInt(100 + marginPercent) + 99n) / 100n;
  if (withMargin > cap) throw new Error(`this transfer needs a fee limit of ${withMargin} sun, above the ${cap} cap`);
  return withMargin;
}

/** Bandwidth a signed transaction uses: its raw data, one 65-byte signature, and protobuf and result overhead. */
export const estimateBandwidth = (rawDataHex: string, signatures = 1) => BigInt(rawDataHex.length / 2 + 65 * signatures + 64 + 5);

export class TronSettlementAdapter implements SettlementPort {
  private readonly cap: bigint;
  private readonly margin: number;
  private readonly now: () => Date;

  constructor(private readonly cfg: TronAdapterConfig) {
    if (railOf(cfg.network) !== "tron") throw new Error(`${cfg.network} is not a TRON network`);
    if (!networkAllowed(cfg.network, { mainnetEnabled: cfg.mainnetEnabled })) throw new Error(`${cfg.network} is not enabled for settlement`);
    this.cap = cfg.maxFeeLimitSun ?? 100_000_000n;
    this.margin = cfg.energyMarginPercent ?? 20;
    this.now = cfg.now ?? (() => new Date());
  }

  async prepareTransfer(t: SettlementTransfer): Promise<PreparedTransaction> {
    if (t.network !== this.cfg.network) throw new Error(`this adapter serves ${this.cfg.network}, not ${t.network}`);
    for (const a of [t.tokenContract, t.from, t.to]) if (!isTronAddress(a)) throw new Error(`not a TRON address: ${a}`);
    if (t.from !== this.cfg.signer.address) throw new Error("the signer must be the sender");
    if (t.from === t.to) throw new Error("sender and recipient are the same");
    if (t.amount <= 0n || t.amount > UINT256_MAX) throw new RangeError("amount must be a positive uint256");
    const { http } = this.cfg;
    const base = { owner_address: t.from, contract_address: t.tokenContract, visible: true };

    // 1. The sender holds enough tokens.
    const bal = await http.post<TriggerResult>("/wallet/triggerconstantcontract", { ...base, function_selector: "balanceOf(address)", parameter: encodeBalanceOfParams(t.from) });
    const balance = decodeUint256(bal.constant_result?.[0] ?? "");
    if (balance < t.amount) throw new InsufficientTokenBalanceError(balance, t.amount);

    // 2. The transfer succeeds in simulation, and costs this much energy.
    const parameter = encodeTransferParams(t.to, t.amount);
    const sim = await http.post<TriggerResult>("/wallet/triggerconstantcontract", { ...base, function_selector: "transfer(address,uint256)", parameter });
    if (!sim.result?.result) throw new Error(`transfer simulation failed: ${tronMessage(sim.result?.message) || sim.result?.code || "unknown"}`);
    if (sim.constant_result?.[0] && decodeUint256(sim.constant_result[0]) !== 1n) throw new Error("the token contract returned false for the transfer");
    const energy = BigInt((sim.energy_used ?? 0) + (sim.energy_penalty ?? 0));

    // 3. Fee limit from the chain's current energy price.
    const params = await http.post<{ chainParameter: { key: string; value?: number }[] }>("/wallet/getchainparameters", {});
    const sunPerEnergy = BigInt(params.chainParameter.find((p) => p.key === "getEnergyFee")?.value ?? 0);
    if (sunPerEnergy <= 0n) throw new Error("the node did not report an energy price");
    const feeLimit = feeLimitFor(energy, sunPerEnergy, this.margin, this.cap);

    // 4. The node builds the transaction; we check every field before signing.
    const built = await http.post<TriggerResult>("/wallet/triggersmartcontract", { ...base, function_selector: "transfer(address,uint256)", parameter, fee_limit: Number(feeLimit), call_value: 0 });
    if (!built.result?.result || !built.transaction) throw new Error(`the node would not build the transfer: ${tronMessage(built.result?.message) || "unknown"}`);
    const tx = built.transaction;
    const raw = this.verify(tx, t, feeLimit);

    // 5. Sign the transaction id, and check the signature is the sender's.
    const signature = (await this.cfg.signer.signTransactionId(tx.txID)).replace(/^0x/, "");
    if (recoverTronSigner(tx.txID, signature) !== t.from) throw new Error("the signer did not sign as the sender");

    return {
      network: this.cfg.network,
      txRef: tx.txID,
      wire: JSON.stringify({ ...tx, signature: [signature] }),
      validity: { expiresAt: new Date(Number(raw.expiration)) },
      fees: { feeLimitSun: feeLimit, estimatedEnergy: energy, estimatedBandwidth: estimateBandwidth(tx.raw_data_hex) },
      summary: {
        action: "trc20_transfer",
        token: t.tokenContract,
        from: t.from,
        to: t.to,
        amount: t.amount.toString(),
        sunPerEnergy: sunPerEnergy.toString(),
        balanceBefore: balance.toString(),
      },
    };
  }

  /** The unsigned transaction is exactly the transfer asked for; anything else is refused. */
  private verify(tx: UnsignedTransaction, t: SettlementTransfer, feeLimit: bigint) {
    const rawBytes = fromHex(tx.raw_data_hex);
    if (toHex(sha256(rawBytes)) !== tx.txID.toLowerCase()) throw new Error("transaction id does not match its contents");
    const raw = decodeRawTransaction(rawBytes);
    if (raw.contracts.length !== 1 || raw.contracts[0]!.type !== TRIGGER_SMART_CONTRACT) throw new Error("not a single smart-contract call");
    const call = decodeTriggerSmartContract(raw.contracts[0]!.value);
    const eq = (a: Uint8Array, b: Uint8Array) => toHex(a) === toHex(b);
    if (!eq(call.owner, tronAddressBytes(t.from))) throw new Error("built transaction has a different sender");
    if (!eq(call.contract, tronAddressBytes(t.tokenContract))) throw new Error("built transaction calls a different contract");
    if (call.callValue !== 0n || call.callTokenValue !== 0n) throw new Error("built transaction sends TRX or TRC-10 as well");
    if (toHex(call.data) !== transferCallData(t.to, t.amount)) throw new Error("built transaction has a different recipient or amount");
    if (raw.feeLimit !== feeLimit) throw new Error("built transaction has a different fee limit");
    const now = BigInt(this.now().getTime());
    if (raw.expiration <= now || raw.expiration > now + 24n * 3600n * 1000n) throw new Error("built transaction has an unacceptable expiration");
    return raw;
  }
}
