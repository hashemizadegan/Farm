/** The few Solana JSON-RPC calls the adapters need, over plain HTTPS. */

export interface SignatureStatus {
  slot: bigint;
  confirmations: number | null;
  err: unknown;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
}

export interface SolanaRpc {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  /** Finalized block height: conservative for deciding that a blockhash has expired. */
  getBlockHeight(): Promise<bigint>;
  getMinimumBalanceForRentExemption(space: number): Promise<bigint>;
  /** Recent per-slot priority fees (micro-lamports per compute unit) touching these accounts. */
  getRecentPrioritizationFees(accounts: string[]): Promise<bigint[]>;
  /** Sends base64 wire bytes; returns the signature. Retries are ours, not the node's. */
  sendTransaction(wireBase64: string): Promise<string>;
  getSignatureStatus(signature: string): Promise<SignatureStatus | null>;
  /** Account data (finalized), or null when the account does not exist. */
  getAccountInfo(address: string): Promise<{ owner: string; data: Uint8Array } | null>;
}

export class SolanaRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "SolanaRpcError";
  }
  /** The node simulated the transaction and it failed: it would never succeed as signed. */
  get preflightFailed(): boolean {
    return this.code === -32002 && !/blockhash not found/i.test(this.message);
  }
  get blockhashNotFound(): boolean {
    return /blockhash not found/i.test(this.message);
  }
  get alreadyProcessed(): boolean {
    return /already (been )?processed/i.test(this.message);
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function httpSolanaRpc(url: string, fetchImpl: Fetch = fetch as unknown as Fetch): SolanaRpc {
  let id = 0;
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!res.ok) throw new SolanaRpcError(res.status, `Solana RPC ${method} returned HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
    if (body.error) throw new SolanaRpcError(body.error.code, body.error.message, body.error.data);
    return body.result as T;
  }
  return {
    async getLatestBlockhash() {
      const r = await call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
      return { blockhash: r.value.blockhash, lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight) };
    },
    async getBlockHeight() {
      return BigInt(await call<number>("getBlockHeight", [{ commitment: "finalized" }]));
    },
    async getMinimumBalanceForRentExemption(space) {
      return BigInt(await call<number>("getMinimumBalanceForRentExemption", [space]));
    },
    async getRecentPrioritizationFees(accounts) {
      const r = await call<{ prioritizationFee: number }[]>("getRecentPrioritizationFees", [accounts]);
      return r.map((x) => BigInt(x.prioritizationFee));
    },
    async sendTransaction(wire) {
      return call<string>("sendTransaction", [wire, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 }]);
    },
    async getSignatureStatus(signature) {
      const r = await call<{ value: ({ slot: number; confirmations: number | null; err: unknown; confirmationStatus: SignatureStatus["confirmationStatus"] } | null)[] }>(
        "getSignatureStatuses",
        [[signature], { searchTransactionHistory: true }],
      );
      const s = r.value[0];
      return s ? { slot: BigInt(s.slot), confirmations: s.confirmations, err: s.err, confirmationStatus: s.confirmationStatus } : null;
    },
    async getAccountInfo(address) {
      const r = await call<{ value: { owner: string; data: [string, string] } | null }>("getAccountInfo", [address, { encoding: "base64", commitment: "finalized" }]);
      return r.value ? { owner: r.value.owner, data: new Uint8Array(Buffer.from(r.value.data[0], "base64")) } : null;
    },
  };
}
