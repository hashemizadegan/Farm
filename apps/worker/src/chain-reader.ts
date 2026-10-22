import { createPublicClient, decodeEventLog, http, parseAbi } from "viem";
import type { ChainReader } from "./handlers/chain";

/** Events emitted by contracts/nft. Keep in sync with the Solidity sources. */
export const INDEXED_EVENTS_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
]);

/**
 * Capability `evm-chain` (packages/config capabilities.ts; docs/provider-capabilities.md): CHAIN_RPC_URL must point to an RPC endpoint you
 * control or trust. It is fixed configuration, never request-derived (SSRF).
 */
export function createViemChainReader(rpcUrl: string): ChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000, retryCount: 2 }) });
  return {
    latestBlock: () => client.getBlockNumber(),
    async blockHash(n) {
      try {
        return (await client.getBlock({ blockNumber: n })).hash ?? undefined;
      } catch {
        return undefined;
      }
    },
    async getLogs(contract, from, to) {
      const logs = await client.getLogs({ address: contract as `0x${string}`, fromBlock: from, toBlock: to });
      return logs.flatMap((l) => {
        try {
          const decoded = decodeEventLog({ abi: INDEXED_EVENTS_ABI, data: l.data, topics: l.topics });
          return [
            {
              blockNumber: l.blockNumber!,
              blockHash: l.blockHash!,
              txHash: l.transactionHash!,
              logIndex: l.logIndex!,
              eventName: decoded.eventName,
              args: decoded.args as Record<string, unknown>,
            },
          ];
        } catch {
          return []; // Unknown event: ignore rather than guess its meaning.
        }
      });
    },
  };
}
