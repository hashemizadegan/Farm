import { HARVEST_REGISTRY_ABI } from "@metafarm/domain";
import { createPublicClient, http, parseAbi } from "viem";
import type { HarvestChainReader } from "../deps";

const abi = parseAbi(HARVEST_REGISTRY_ABI);

/** Reads HarvestRegistry entries. RPC URL and address are fixed configuration, never request-derived. */
export function createHarvestChainReader(rpcUrl: string, registry: string): HarvestChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 5_000, retryCount: 1 }) });
  return {
    async entryOf(batchId) {
      const [recordHash, recordedAt, voidedAt] = await client.readContract({
        address: registry as `0x${string}`,
        abi,
        functionName: "entryOf",
        args: [batchId],
      });
      return { recordHash, recordedAt, voidedAt };
    },
  };
}
