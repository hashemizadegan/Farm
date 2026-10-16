import type { ApiEnv } from "@metafarm/config";
import type { Pool } from "@metafarm/db";
import type { JobPayloads } from "@metafarm/domain";
import type { Logger } from "@metafarm/observability";
import type { AuthProvider } from "./auth/provider";
import type { ObjectStorage } from "./storage/object-storage";

export interface JobProducer {
  enqueue<Q extends keyof JobPayloads>(queue: Q, payload: JobPayloads[Q]): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface Deps {
  env: ApiEnv;
  logger: Logger;
  pool: Pool;
  jobs: JobProducer;
  storage: ObjectStorage;
  auth: AuthProvider;
  /** Recovers the signer of an EIP-191 personal message. Injected for testability. */
  recoverMessageAddress: (message: string, signature: `0x${string}`) => Promise<string>;
  now: () => Date;
}
