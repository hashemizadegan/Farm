/**
 * Token-2022 ownership from finalized transactions. The RPC responses below follow the Solana JSON-RPC
 * response shapes (getSlot, getSignaturesForAddress, getTransaction with encoding "json"); they are
 * constructed for the tests, not recorded from a live cluster.
 */
import { describe, expect, it } from "vitest";
import { rebuildOwnership, type ChainAssetRef } from "@metafarm/domain";
import { base58Encode } from "../solana/base58";
import { TOKEN_2022_PROGRAM } from "../solana/keys";
import { executedInstructions, httpSolanaHistoryRpc, type HistoryTransaction, type SolanaHistoryRpc, type TokenBalance } from "./solana-history-rpc";
import { OwnershipHistoryError, createToken2022OwnershipSource, ownershipEventsFromBalances } from "./token2022-ownership-source";

const key = (b: number) => base58Encode(new Uint8Array(32).fill(b));
const sig = (b: number) => base58Encode(new Uint8Array(64).fill(b));
const MINT = key(40);
const asset: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: MINT };
const A = key(41);
const B = key(42);
const C = key(43);
const bal = (accountIndex: number, owner: string | undefined, amount: bigint, mint = MINT, programId = TOKEN_2022_PROGRAM): TokenBalance => ({ accountIndex, mint, owner, programId, amount: amount.toString() });
const tx = (pre: TokenBalance[], post: TokenBalance[]) => ({ signature: sig(1), slot: 10n, txIndex: 0, pre, post });

describe("ownershipEventsFromBalances", () => {
  it("turns a new balance into a mint, a move into a transfer and a removed balance into a burn", () => {
    expect(ownershipEventsFromBalances(asset, tx([], [bal(1, A, 1_000n)])).map((e) => [e.kind, e.from, e.to, e.amount])).toEqual([["mint", null, A, 1_000n]]);
    expect(ownershipEventsFromBalances(asset, tx([bal(1, A, 1_000n), bal(2, B, 0n)], [bal(1, A, 750n), bal(2, B, 250n)])).map((e) => [e.kind, e.from, e.to, e.amount])).toEqual([["transfer", A, B, 250n]]);
    expect(ownershipEventsFromBalances(asset, tx([bal(1, A, 750n)], [bal(1, A, 700n)])).map((e) => [e.kind, e.from, e.to, e.amount])).toEqual([["burn", A, null, 50n]]);
  });

  it("pairs several senders and receivers deterministically and numbers the events", () => {
    const owners = [A, B, C].sort();
    // owners[0] sends 30, owners[1] sends 20, owners[2] receives 40 and 10 is burned.
    const events = ownershipEventsFromBalances(asset, tx([bal(1, owners[0], 30n), bal(2, owners[1], 20n)], [bal(3, owners[2], 40n)]));
    expect(events.map((e) => [e.kind, e.from, e.to, e.amount, e.ixIndex])).toEqual([
      ["transfer", owners[0], owners[2], 30n, 0],
      ["transfer", owners[1], owners[2], 10n, 1],
      ["burn", owners[1], null, 10n, 2],
    ]);
  });

  it("nets an owner's accounts, ignores other mints and programs, and refuses a balance without an owner", () => {
    expect(ownershipEventsFromBalances(asset, tx([bal(1, A, 5n), bal(2, A, 0n)], [bal(1, A, 0n), bal(2, A, 5n)]))).toEqual([]);
    expect(ownershipEventsFromBalances(asset, tx([bal(1, A, 5n, key(99))], []))).toEqual([]);
    expect(ownershipEventsFromBalances(asset, tx([], [bal(1, A, 5n, MINT, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")]))).toEqual([]);
    expect(() => ownershipEventsFromBalances(asset, tx([], [bal(1, undefined, 5n)]))).toThrow(OwnershipHistoryError);
  });
});

/** A fake node: signatures newest first, transactions by signature. */
function node(finalized: bigint, entries: { s: number; slot: bigint; err?: unknown; pre: TokenBalance[]; post: TokenBalance[] }[]): SolanaHistoryRpc & { pages: number } {
  const newestFirst = [...entries].sort((a, b) => (a.slot === b.slot ? b.s - a.s : a.slot < b.slot ? 1 : -1));
  const txs = new Map<string, HistoryTransaction>(entries.map((e) => [sig(e.s), { slot: e.slot, err: e.err ?? null, preTokenBalances: e.pre, postTokenBalances: e.post, instructions: [] }]));
  const rpc = {
    pages: 0,
    async getFinalizedSlot() {
      return finalized;
    },
    async getSignaturesForAddress(address: string, opts: { before?: string; limit: number }) {
      expect(address).toBe(MINT);
      rpc.pages++;
      const start = opts.before ? newestFirst.findIndex((e) => sig(e.s) === opts.before) + 1 : 0;
      return newestFirst.slice(start, start + opts.limit).map((e) => ({ signature: sig(e.s), slot: e.slot, err: e.err ?? null }));
    },
    async getTransaction(signature: string) {
      return txs.get(signature) ?? null;
    },
  };
  return rpc;
}

const history = [
  { s: 1, slot: 100n, pre: [], post: [bal(1, A, 1_000_000n)] },
  { s: 2, slot: 900n, pre: [bal(1, A, 1_000_000n)], post: [bal(1, A, 750_000n), bal(2, B, 250_000n)] },
  { s: 3, slot: 900n, err: { InstructionError: [0, "Custom"] }, pre: [], post: [] },
  { s: 4, slot: 1_500n, pre: [bal(2, B, 250_000n)], post: [bal(2, B, 200_000n), bal(3, C, 50_000n)] },
];

describe("Token-2022 ownership source", () => {
  it("covers Token-2022 on its own network only", () => {
    const src = createToken2022OwnershipSource(node(0n, []), "solana-devnet");
    expect(src.covers(asset)).toBe(true);
    expect(src.covers({ ...asset, network: "solana-mainnet" })).toBe(false);
    expect(src.covers({ ...asset, rail: "SOLANA_BUBBLEGUM_CNFT" })).toBe(false);
  });

  it("reads finalized history oldest first across pages, skips failed transactions, and stops at the cursor", async () => {
    const rpc = node(1_000n, history);
    const src = createToken2022OwnershipSource(rpc, "solana-devnet", { pageSize: 1 });
    const first = await src.eventsAfter(asset, null);
    expect(first.throughSlot).toBe(1_000n);
    expect(first.events.map((e) => [e.kind, e.slot, e.signature])).toEqual([
      ["mint", 100n, sig(1)],
      ["transfer", 900n, sig(2)],
    ]);
    // Rebuilt like the index reader does: A holds 750 000, B 250 000.
    expect(rebuildOwnership(first.events).holdings.map((h) => [h.owner, h.amount])).toEqual([[A, 750_000n], [B, 250_000n]].sort((x, y) => ((x[0] as string) < (y[0] as string) ? -1 : 1)));
    expect(rpc.pages).toBeGreaterThan(1);

    const later = createToken2022OwnershipSource(node(2_000n, history), "solana-devnet");
    const next = await later.eventsAfter(asset, 1_000n);
    expect(next.events.map((e) => [e.kind, e.from, e.to, e.amount, e.slot])).toEqual([["transfer", B, C, 50_000n, 1_500n]]);
  });

  it("numbers same-slot transactions in listing order, and refuses what it cannot read completely", async () => {
    const src = createToken2022OwnershipSource(node(1_000n, history), "solana-devnet");
    const { events } = await src.eventsAfter(asset, null);
    expect(events.find((e) => e.slot === 900n)!.txIndex).toBe(0);
    const missing = { ...node(1_000n, history), getTransaction: async () => null };
    await expect(createToken2022OwnershipSource(missing, "solana-devnet").eventsAfter(asset, null)).rejects.toBeInstanceOf(OwnershipHistoryError);
    await expect(createToken2022OwnershipSource(node(1_000n, history), "solana-devnet", { maxTransactions: 1 }).eventsAfter(asset, null)).rejects.toBeInstanceOf(OwnershipHistoryError);
    await expect(createToken2022OwnershipSource(node(1_000n, history), "solana-mainnet").eventsAfter(asset, null)).rejects.toBeInstanceOf(OwnershipHistoryError);
  });

  it("stores nothing on a first window without a mint, so missing history never reads as no holders", async () => {
    // No history at all (or a node that kept none) and history that starts after the mint.
    await expect(createToken2022OwnershipSource(node(1_000n, []), "solana-devnet").eventsAfter(asset, null)).rejects.toBeInstanceOf(OwnershipHistoryError);
    await expect(createToken2022OwnershipSource(node(1_000n, history.slice(1)), "solana-devnet").eventsAfter(asset, null)).rejects.toBeInstanceOf(OwnershipHistoryError);
    // A later window may hold no mint: the cursor shows that the earlier history was read.
    const quiet = await createToken2022OwnershipSource(node(2_000n, history), "solana-devnet").eventsAfter(asset, 1_600n);
    expect(quiet).toEqual({ events: [], throughSlot: 2_000n });
  });
});

describe("httpSolanaHistoryRpc", () => {
  it("asks for finalized data only and maps the responses", async () => {
    const calls: { method: string; params: unknown[] }[] = [];
    const results: Record<string, unknown> = {
      getSlot: 1_234,
      getSignaturesForAddress: [{ signature: sig(1), slot: 100, err: null, memo: null, blockTime: 1 }],
      getTransaction: {
        slot: 100,
        meta: { err: null, preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: A, programId: TOKEN_2022_PROGRAM, uiTokenAmount: { amount: "5", decimals: 0, uiAmount: 5, uiAmountString: "5" } }] },
        transaction: { message: { accountKeys: [], instructions: [] }, signatures: [sig(1)] },
      },
    };
    const fetchImpl = async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as { method: string; params: unknown[] };
      calls.push({ method: b.method, params: b.params });
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: results[b.method] }) };
    };
    const rpc = httpSolanaHistoryRpc("https://rpc.example.test", fetchImpl);
    expect(Object.keys(rpc).sort()).toEqual(["getFinalizedSlot", "getSignaturesForAddress", "getTransaction"]);
    expect(await rpc.getFinalizedSlot()).toBe(1_234n);
    expect(await rpc.getSignaturesForAddress(MINT, { limit: 10, before: sig(2) })).toEqual([{ signature: sig(1), slot: 100n, err: null }]);
    expect(await rpc.getTransaction(sig(1))).toEqual({ slot: 100n, err: null, preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: A, programId: TOKEN_2022_PROGRAM, amount: "5" }], instructions: [] });
    expect(calls).toEqual([
      { method: "getSlot", params: [{ commitment: "finalized" }] },
      { method: "getSignaturesForAddress", params: [MINT, { commitment: "finalized", limit: 10, before: sig(2) }] },
      { method: "getTransaction", params: [sig(1), { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }] },
    ]);
  });
});

describe("executedInstructions", () => {
  it("resolves lookup-table accounts and runs each instruction's inner instructions right after it", () => {
    const [p1, p2, p3, x, y, z] = [key(1), key(2), key(3), key(4), key(5), key(6)] as const;
    const byte = base58Encode(Uint8Array.of(0x6f));
    const out = executedInstructions({
      slot: 1,
      meta: { err: null, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 4, accounts: [5], data: byte }] }], loadedAddresses: { writable: [y], readonly: [z] } },
      transaction: { message: { accountKeys: [p1, p2, p3, x], instructions: [{ programIdIndex: 0, accounts: [3, 4], data: "" }, { programIdIndex: 1, accounts: [], data: "" }] } },
    });
    expect(out.map((i) => [i.programId, i.accounts])).toEqual([
      [p1, [x, y]],
      [y, [z]],
      [p2, []],
    ]);
    expect(Array.from(out[1]!.data)).toEqual([0x6f]);
    expect(() => executedInstructions({ slot: 1, meta: null, transaction: { message: { accountKeys: [p1], instructions: [{ programIdIndex: 3, accounts: [], data: "" }] } } })).toThrow(/outside/);
  });
});
