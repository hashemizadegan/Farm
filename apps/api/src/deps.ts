import type { SolanaRpc, TronHttp } from "@metafarm/chain";
import type { ApiEnv } from "@metafarm/config";
import type { Pool } from "@metafarm/db";
import type { JobPayloads, OwnershipReader } from "@metafarm/domain";
import type { Logger } from "@metafarm/observability";
import type { AuthProvider } from "./auth/provider";
import type { SolanaClusterCheck } from "./lib/solana-cluster";
import type { ObjectStorage } from "@metafarm/storage";
import type { Redis } from "ioredis";

export interface JobProducer {
  enqueue<Q extends keyof JobPayloads>(queue: Q, payload: JobPayloads[Q]): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Read access to the HarvestRegistry contract, for live checks on the public page. */
export interface HarvestChainReader {
  entryOf(batchId: `0x${string}`): Promise<{ recordHash: string; recordedAt: bigint; voidedAt: bigint }>;
}

export interface Deps {
  env: ApiEnv;
  logger: Logger;
  pool: Pool;
  jobs: JobProducer;
  storage: ObjectStorage;
  auth: AuthProvider;
  /** Recovers the signer of an EIP-191 personal message. Injected for testability. */
  now: () => Date;
  /** Present when CHAIN_RPC_URL and HARVEST_REGISTRY_ADDRESS are configured. */
  harvestChain?: HarvestChainReader;
  /** TRON node for verifying incoming payments; present when RWA_TRON_API_URL is configured. */
  tron?: TronHttp;
  /** Solana node for checking share-token mints; present when RWA_SOLANA_RPC_URL is configured. */
  solanaRpc?: SolanaRpc;
  /** Proves solanaRpc serves RWA_SOLANA_NETWORK (getGenesisHash); required wherever solanaRpc is read. */
  solanaCluster?: SolanaClusterCheck;
  /**
   * Who holds an asset on chain, for the digital twin. Absent by default: the twin then reports
   * ownership as `not_indexed` and never substitutes its own records.
   */
  ownershipReader?: OwnershipReader;
  /** Shared rate-limit counters; required when RATE_LIMIT_STORE is `redis`, ignored otherwise. */
  rateLimitRedis?: Redis;
}
