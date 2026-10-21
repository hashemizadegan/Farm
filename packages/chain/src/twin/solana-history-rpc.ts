/**
 * Read-only Solana history calls for the ownership index, at `finalized` commitment. Deliberately a
 * separate interface from SolanaRpc: it has no way to send anything.
 */
import { base58Decode } from "../solana/base58";
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

/** One instruction as executed, with its accounts resolved (including address lookup tables). */
export interface ExecutedInstruction {
  programId: string;
  accounts: string[];
  data: Uint8Array;
}

export interface HistoryTransaction {
  slot: bigint;
  err: unknown;
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
  /** Every instruction in execution order: each top-level instruction followed by the instructions it invoked. */
  instructions: ExecutedInstruction[];
}

export interface SolanaHistoryRpc {
  getFinalizedSlot(): Promise<bigint>;
  /** Newest first, finalized only; `before` pages backwards. */
  getSignaturesForAddress(address: string, opts: { before?: string; limit: number }): Promise<HistorySignature[]>;
  getTransaction(signature: string): Promise<HistoryTransaction | null>;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RawInstruction {
  programIdIndex: number;
  accounts: number[];
  data: string;
}

/** A getTransaction result (encoding "json"), as far as these readers use it. */
export interface RawHistoryTransaction {
  slot: number;
  meta: {
    err: unknown;
    preTokenBalances?: RawBalance[];
    postTokenBalances?: RawBalance[];
    innerInstructions?: { index: number; instructions: RawInstruction[] }[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
  transaction: { message: { accountKeys: string[]; instructions: RawInstruction[] } };
}

/** Resolves account indexes (static keys, then lookup-table writable, then readonly) and orders inner instructions after their parent. */
export function executedInstructions(raw: RawHistoryTransaction): ExecutedInstruction[] {
  const keys = [...raw.transaction.message.accountKeys, ...(raw.meta?.loadedAddresses?.writable ?? []), ...(raw.meta?.loadedAddresses?.readonly ?? [])];
  const key = (i: number) => {
    const k = keys[i];
    if (k === undefined) throw new Error(`account index ${i} is outside the transaction's ${keys.length} accounts`);
    return k;
  };
  const resolve = (ix: RawInstruction): ExecutedInstruction => ({ programId: key(ix.programIdIndex), accounts: ix.accounts.map(key), data: base58Decode(ix.data) });
  const inner = new Map<number, RawInstruction[]>();
  for (const group of raw.meta?.innerInstructions ?? []) inner.set(group.index, group.instructions);
  const out: ExecutedInstruction[] = [];
  raw.transaction.message.instructions.forEach((ix, i) => {
    out.push(resolve(ix));
    for (const child of inner.get(i) ?? []) out.push(resolve(child));
  });
  return out;
}

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
      const r = await call<RawHistoryTransaction | null>("getTransaction", [
        signature,
        { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 },
      ]);
      if (!r) return null;
      return {
        slot: BigInt(r.slot),
        err: r.meta?.err ?? null,
        preTokenBalances: balances(r.meta?.preTokenBalances),
        postTokenBalances: balances(r.meta?.postTokenBalances),
        instructions: executedInstructions(r),
      };
    },
  };
}
