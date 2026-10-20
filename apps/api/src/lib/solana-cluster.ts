/**
 * Proves the API's Solana RPC serves the configured network before it reads a mint from it. The
 * network setting is only a label; `getGenesisHash` identifies the cluster (see packages/chain
 * cluster.ts). A success is remembered only for the exact URL and network that passed: if either
 * differs on a later call, it is checked again (in practice they change only with a redeploy,
 * which starts a new process). A failure is never remembered, so the next request checks again.
 */
import { verifySolanaCluster, type ClusterCheck } from "@metafarm/chain";
import type { Network } from "@metafarm/domain";

export type SolanaClusterCheck = () => Promise<void>;

export function solanaClusterCheck(
  current: () => { url: string; network: Network },
  verify: (c: ClusterCheck) => Promise<void> = verifySolanaCluster,
): SolanaClusterCheck {
  // The pair that passed, compared by value; never logged.
  let verified: { url: string; network: Network } | undefined;
  return async () => {
    const { url, network } = current();
    if (verified && verified.url === url && verified.network === network) return;
    verified = undefined;
    // A request is waiting: two quick attempts, not the worker's startup budget.
    await verify({ url, network, label: "RPC", attempts: 2, timeoutMs: 5_000, retryDelayMs: 500 });
    verified = { url, network };
  };
}
