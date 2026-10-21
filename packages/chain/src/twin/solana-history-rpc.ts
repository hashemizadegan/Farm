/**
 * Read-only Solana history calls for the ownership index, at `finalized` commitment. Deliberately a
 * separate interface from SolanaRpc: it has no way to send anything.
 */
import { SolanaRpcError } from "../solana/rpc";

export interface HistorySignature {
  signature: string;
  slot: bigint;
  err: unknown;
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  /** Owner of the token account; RPC nodes omit it only for very old transactions. */
  owner?: string;
  programId?: string;
  /** Base units, as a decimal string. */
  amount: string;
}

export interface HistoryTransaction {
  slot: bigint;
  err: unknown;
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
}

export interface SolanaHistoryRpc {
  getFinalizedSlot(): Promise<bigint>;
  /** Newest first, finalized only; `before` pages backwards. */
  getSignaturesForAddress(address: string, opts: { before?: string; limit: number }): Promise<HistorySignature[]>;
  getTransaction(signature: string): Promise<HistoryTransaction | null>;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface RawBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string };
}

export function httpSolanaHistoryRpc(url: string, fetchImpl: Fetch = fetch as unknown as Fetch): SolanaHistoryRpc {
  let id = 0;
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (!res.ok) throw new SolanaRpcError(res.status, `Solana RPC ${method} returned HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
    if (body.error) throw new SolanaRpcError(body.error.code, body.error.message, body.error.data);
    return body.result as T;
  }
  const balances = (xs: RawBalance[] | null | undefined): TokenBalance[] =>
    (xs ?? []).map((b) => ({ accountIndex: b.accountIndex, mint: b.mint, owner: b.owner, programId: b.programId, amount: b.uiTokenAmount.amount }));
  return {
    async getFinalizedSlot() {
      return BigInt(await call<number>("getSlot", [{ commitment: "finalized" }]));
    },
    async getSignaturesForAddress(address, opts) {
      const r = await call<{ signature: string; slot: number; err: unknown }[]>("getSignaturesForAddress", [
        address,
        { commitment: "finalized", limit: opts.limit, ...(opts.before ? { before: opts.before } : {}) },
      ]);
      return r.map((s) => ({ signature: s.signature, slot: BigInt(s.slot), err: s.err ?? null }));
    },
    async getTransaction(signature) {
      const r = await call<{ slot: number; meta: { err: unknown; preTokenBalances?: RawBalance[]; postTokenBalances?: RawBalance[] } | null } | null>("getTransaction", [
        signature,
        { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 },
      ]);
      if (!r) return null;
      return { slot: BigInt(r.slot), err: r.meta?.err ?? null, preTokenBalances: balances(r.meta?.preTokenBalances), postTokenBalances: balances(r.meta?.postTokenBalances) };
    },
  };
}
