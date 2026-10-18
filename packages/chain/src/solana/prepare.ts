/** Shared final step of every Solana adapter: compute budget, fresh blockhash, sign, serialize. */
import type { Ed25519Signer, Network, PreparedTransaction } from "@metafarm/domain";
import { toBase64 } from "../bytes";
import { compileMessage, signAndSerialize, type Instruction, type SignFn } from "./codec";
import { setComputeUnitLimit, setComputeUnitPrice } from "./instructions";
import type { SolanaRpc } from "./rpc";

/** The 75th percentile of recent non-zero fees, capped. Zero when the network is quiet. */
export function choosePriorityFee(recent: bigint[], cap: bigint): bigint {
  const paid = recent.filter((f) => f > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (paid.length === 0) return 0n;
  const p75 = paid[Math.min(paid.length - 1, Math.floor(paid.length * 0.75))]!;
  return p75 > cap ? cap : p75;
}

export async function prepareSolanaTransaction(p: {
  network: Network;
  rpc: SolanaRpc;
  signer: Ed25519Signer;
  computeUnitLimit: number;
  feeCap: bigint;
  body: Instruction[];
  /** Accounts the transaction writes, for the priority-fee estimate. */
  writable: string[];
  extraSigners?: Map<string, SignFn>;
  summary: Record<string, unknown>;
}): Promise<PreparedTransaction> {
  const fee = choosePriorityFee(await p.rpc.getRecentPrioritizationFees(p.writable), p.feeCap);
  const instructions = [setComputeUnitLimit(p.computeUnitLimit), ...(fee > 0n ? [setComputeUnitPrice(fee)] : []), ...p.body];
  const { blockhash, lastValidBlockHeight } = await p.rpc.getLatestBlockhash();
  const compiled = compileMessage(p.signer.address, blockhash, instructions);
  const signers = new Map<string, SignFn>([[p.signer.address, (m) => p.signer.signMessage(m)], ...(p.extraSigners ?? [])]);
  const { wire, signature } = await signAndSerialize(compiled, signers);
  return {
    network: p.network,
    txRef: signature,
    wire: toBase64(wire),
    validity: { lastValidBlockHeight },
    fees: { priorityFeeMicroLamports: fee, computeUnitLimit: p.computeUnitLimit },
    summary: { ...p.summary, feePayer: p.signer.address, recentBlockhash: blockhash },
  };
}
