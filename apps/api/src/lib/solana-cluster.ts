/**
 * Proves the API's Solana RPC serves the configured network before it reads a mint from it. The
 * network setting is only a label; `getGenesisHash` identifies the cluster (see packages/chain
 * cluster.ts). A success is remembered for the life of the process (the URL cannot change without
 * a redeploy); a failure is not, so the next request checks again.
 */
import { verifySolanaCluster, type ClusterCheck } from "@metafarm/chain";
import type { Network } from "@metafarm/domain";

export type SolanaClusterCheck = () => Promise<void>;

export function solanaClusterCheck(
  o: { url: string; network: Network },
  verify: (c: ClusterCheck) => Promise<void> = verifySolanaCluster,
): SolanaClusterCheck {
  let verified = false;
  return async () => {
    if (verified) return;
    // A request is waiting: two quick attempts, not the worker's startup budget.
    await verify({ url: o.url, network: o.network, label: "RPC", attempts: 2, timeoutMs: 5_000, retryDelayMs: 500 });
    verified = true;
  };
}
