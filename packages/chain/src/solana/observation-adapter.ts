/** ChainObservationPort on Solana: send signed transactions and read their fate. */
import { railOf, type ChainObservation, type ChainObservationPort, type Network, type PreparedTransaction } from "@metafarm/domain";
import { SolanaRpcError, type SignatureStatus, type SolanaRpc } from "./rpc";

export class SolanaSubmitError extends Error {
  constructor(
    message: string,
    /** The transaction can never land as signed (simulation failed): record it as failed. */
    public readonly definitive: boolean,
  ) {
    super(message);
    this.name = "SolanaSubmitError";
  }
}

export class SolanaObservationAdapter implements ChainObservationPort {
  constructor(private readonly cfg: { network: Network; rpc: SolanaRpc }) {
    if (railOf(cfg.network) !== "solana") throw new Error(`${cfg.network} is not a Solana network`);
  }

  async submit(prepared: PreparedTransaction): Promise<void> {
    if (prepared.network !== this.cfg.network) throw new Error(`this adapter serves ${this.cfg.network}, not ${prepared.network}`);
    try {
      await this.cfg.rpc.sendTransaction(prepared.wire);
    } catch (err) {
      if (err instanceof SolanaRpcError) {
        // A re-send of a landed transaction: nothing to do.
        if (err.alreadyProcessed) return;
        if (err.preflightFailed) throw new SolanaSubmitError(err.message, true);
      }
      // Network trouble or an unknown blockhash: not definitive; observation will decide.
      throw new SolanaSubmitError((err as Error).message, false);
    }
  }

  async observe(t: { network: Network; txRef: string; lastValidBlockHeight?: bigint }): Promise<ChainObservation> {
    const first = await this.cfg.rpc.getSignatureStatus(t.txRef);
    if (first) return fromStatus(first);
    if (t.lastValidBlockHeight === undefined) return { status: "not_found" };
    // Past the blockhash's last valid height (finalized), it can no longer land; check once more to close the race.
    if ((await this.cfg.rpc.getBlockHeight()) <= t.lastValidBlockHeight) return { status: "pending" };
    const again = await this.cfg.rpc.getSignatureStatus(t.txRef);
    return again ? fromStatus(again) : { status: "expired" };
  }
}

function fromStatus(s: SignatureStatus): ChainObservation {
  if (s.err) return { status: "failed", slotOrBlock: s.slot, error: JSON.stringify(s.err) };
  if (s.confirmationStatus === "finalized") return { status: "final", slotOrBlock: s.slot };
  return { status: "observed", slotOrBlock: s.slot, ...(s.confirmations !== null ? { confirmations: s.confirmations } : {}) };
}
