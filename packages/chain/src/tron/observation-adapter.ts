/**
 * ChainObservationPort on TRON. Final means solidified: included in a block confirmed by 19 of the
 * 27 super representatives (the solidity node's view).
 */
import { railOf, type ChainObservation, type ChainObservationPort, type Network, type PreparedTransaction } from "@metafarm/domain";
import { tronMessage, type TronHttp } from "./http";

interface TxInfo {
  id?: string;
  blockNumber?: number;
  fee?: number;
  result?: string;
  resMessage?: string;
  receipt?: { result?: string };
}

interface Block {
  block_header?: { raw_data?: { number?: number; timestamp?: number } };
}

export class TronSubmitError extends Error {
  constructor(
    message: string,
    /** Refused for good (bad signature, expired, contract validation): record as failed or expired. */
    public readonly definitive: boolean,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "TronSubmitError";
  }
}

const DEFINITIVE = new Set(["SIGERROR", "CONTRACT_VALIDATE_ERROR", "CONTRACT_EXE_ERROR", "TRANSACTION_EXPIRATION_ERROR", "TAPOS_ERROR", "TOO_BIG_TRANSACTION_ERROR", "BANDWITH_ERROR"]);

export class TronObservationAdapter implements ChainObservationPort {
  constructor(private readonly cfg: { network: Network; http: TronHttp }) {
    if (railOf(cfg.network) !== "tron") throw new Error(`${cfg.network} is not a TRON network`);
  }

  async submit(prepared: PreparedTransaction): Promise<void> {
    if (prepared.network !== this.cfg.network) throw new Error(`this adapter serves ${this.cfg.network}, not ${prepared.network}`);
    const r = await this.cfg.http.post<{ result?: boolean; code?: string; message?: string }>("/wallet/broadcasttransaction", JSON.parse(prepared.wire) as Record<string, unknown>);
    if (r.result) return;
    // The node already has it: a re-send.
    if (r.code === "DUP_TRANSACTION_ERROR") return;
    throw new TronSubmitError(`${r.code ?? "UNKNOWN"}: ${tronMessage(r.message)}`, DEFINITIVE.has(r.code ?? ""), r.code);
  }

  async observe(t: { network: Network; txRef: string; expiresAt?: Date }): Promise<ChainObservation> {
    const found = await this.lookup(t.txRef);
    if (found) return found;
    if (!t.expiresAt) return { status: "not_found" };
    // Once the solidified chain is past the expiration, no block can include it any more.
    const solid = await this.cfg.http.post<Block>("/walletsolidity/getnowblock", {});
    const solidTime = solid.block_header?.raw_data?.timestamp ?? 0;
    if (solidTime <= t.expiresAt.getTime()) return { status: "pending" };
    return (await this.lookup(t.txRef)) ?? { status: "expired" };
  }

  private async lookup(txId: string): Promise<ChainObservation | null> {
    const { http } = this.cfg;
    const solid = await http.post<TxInfo>("/walletsolidity/gettransactioninfobyid", { value: txId });
    if (solid.id) {
      const outcome = solid.receipt?.result;
      if (solid.result === "FAILED" || (outcome && outcome !== "SUCCESS")) {
        return { status: "failed", slotOrBlock: BigInt(solid.blockNumber ?? 0), error: [outcome, tronMessage(solid.resMessage)].filter(Boolean).join(": ") || "failed", feePaid: BigInt(solid.fee ?? 0) };
      }
      return { status: "final", slotOrBlock: BigInt(solid.blockNumber ?? 0), feePaid: BigInt(solid.fee ?? 0) };
    }
    const latest = await http.post<TxInfo>("/wallet/gettransactioninfobyid", { value: txId });
    if (latest.id && latest.blockNumber !== undefined) {
      const head = await http.post<Block>("/wallet/getnowblock", {});
      const confirmations = Math.max(0, (head.block_header?.raw_data?.number ?? latest.blockNumber) - latest.blockNumber);
      return { status: "observed", slotOrBlock: BigInt(latest.blockNumber), confirmations };
    }
    return null;
  }
}
