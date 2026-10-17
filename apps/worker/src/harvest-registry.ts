import { HARVEST_REGISTRY_ABI } from "@metafarm/domain";
import { WaitForTransactionReceiptTimeoutError, createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { HarvestRegistryClient } from "./handlers/harvest";

const abi = parseAbi(HARVEST_REGISTRY_ABI);

/**
 * viem-backed registry client. RPC URL, chain, address and key are fixed
 * configuration (never request-derived). The key only needs RECORDER_ROLE.
 */
export function createHarvestRegistryClient(cfg: {
  rpcUrl: string;
  chainId: number;
  chainName?: string;
  address: string;
  privateKey: `0x${string}`;
  confirmations: number;
  timeoutSeconds: number;
}): HarvestRegistryClient {
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainName ?? `chain-${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const transport = http(cfg.rpcUrl, { timeout: 15_000, retryCount: 2 });
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account: privateKeyToAccount(cfg.privateKey) });
  const address = cfg.address as `0x${string}`;

  return {
    chainId: cfg.chainId,
    address: cfg.address.toLowerCase(),
    async entryOf(batchId) {
      const [recordHash, recordedAt, voidedAt] = await publicClient.readContract({ address, abi, functionName: "entryOf", args: [batchId] });
      return { recordHash, recordedAt, voidedAt };
    },
    async record(batchId, recordHash) {
      // Simulate first so a revert (e.g. missing role) fails here, without spending gas.
      const { request } = await publicClient.simulateContract({ address, abi, functionName: "record", args: [batchId, recordHash], account: wallet.account });
      return wallet.writeContract(request);
    },
    async voidBatch(batchId, reasonHash) {
      const { request } = await publicClient.simulateContract({ address, abi, functionName: "voidBatch", args: [batchId, reasonHash], account: wallet.account });
      return wallet.writeContract(request);
    },
    async waitFor(hash) {
      try {
        const r = await publicClient.waitForTransactionReceipt({ hash, confirmations: Math.max(1, cfg.confirmations), timeout: cfg.timeoutSeconds * 1000 });
        return { status: r.status, blockNumber: r.blockNumber };
      } catch (err) {
        if (err instanceof WaitForTransactionReceiptTimeoutError) return "timeout";
        throw err;
      }
    },
  };
}
