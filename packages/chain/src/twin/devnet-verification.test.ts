/**
 * Y15 offline harness: a recorded-shape (constructed, not live) devnet history goes through the Token-2022 source,
 * and the resulting holdings are compared with an explorer export at a slot. No network.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { ChainAssetRef, OwnershipEvent } from "@metafarm/domain";
import { base58Encode } from "../solana/base58";
import { TOKEN_2022_PROGRAM } from "../solana/keys";
import type { HistoryTransaction, SolanaHistoryRpc, TokenBalance } from "./solana-history-rpc";
import { createToken2022OwnershipSource } from "./token2022-ownership-source";
import { compareWithExplorer } from "./devnet-verification";

const key = (b: number) => base58Encode(new Uint8Array(32).fill(b));
const sig = (b: number) => base58Encode(new Uint8Array(64).fill(b));
const MINT = key(70);
const asset: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: MINT };
const [A, B, C] = [key(71), key(72), key(73)];
const bal = (i: number, owner: string, amount: bigint): TokenBalance => ({ accountIndex: i, mint: MINT, owner, programId: TOKEN_2022_PROGRAM, amount: amount.toString() });

function node(finalized: bigint, entries: { s: number; slot: bigint; pre: TokenBalance[]; post: TokenBalance[] }[]): SolanaHistoryRpc {
  const newestFirst = [...entries].sort((a, b) => (a.slot === b.slot ? b.s - a.s : a.slot < b.slot ? 1 : -1));
  const txs = new Map<string, HistoryTransaction>(entries.map((e) => [sig(e.s), { slot: e.slot, err: null, preTokenBalances: e.pre, postTokenBalances: e.post, instructions: [] }]));
  return {
    getFinalizedSlot: async () => finalized,
    getSignaturesForAddress: async (_a, opts) => {
      const start = opts.before ? newestFirst.findIndex((e) => sig(e.s) === opts.before) + 1 : 0;
      return newestFirst.slice(start, start + opts.limit).map((e) => ({ signature: sig(e.s), slot: e.slot, err: null }));
    },
    getTransaction: async (s) => txs.get(s) ?? null,
  };
}

const history = [
  { s: 1, slot: 100n, pre: [], post: [bal(1, A, 1_000_000n)] },
  { s: 2, slot: 900n, pre: [bal(1, A, 1_000_000n)], post: [bal(1, A, 750_000n), bal(2, B, 250_000n)] },
  { s: 3, slot: 1_500n, pre: [bal(2, B, 250_000n)], post: [bal(2, B, 200_000n), bal(3, C, 50_000n)] },
];

describe("devnet verification, offline (Y15)", () => {
  let events: OwnershipEvent[];
  let throughSlot: bigint;
  beforeAll(async () => {
    ({ events, throughSlot } = await createToken2022OwnershipSource(node(2_000n, history), "solana-devnet").eventsAfter(asset, null));
  });

  it("matches an explorer export at a slot the index covers", () => {
    expect(compareWithExplorer(asset, events, throughSlot, { slot: 1_000n, balances: { [A]: "750000", [B]: "250000" } })).toEqual({ status: "match", atSlot: 1_000n, owners: 2 });
    expect(compareWithExplorer(asset, events, throughSlot, { slot: 2_000n, balances: { [A]: "750000", [B]: "200000", [C]: "50000", [key(74)]: "0" } })).toMatchObject({ status: "match", owners: 3 });
  });

  it("reports every owner whose balance differs, either way", () => {
    const r = compareWithExplorer(asset, events, throughSlot, { slot: 2_000n, balances: { [A]: "750000", [B]: "250000", [key(74)]: "1" } });
    expect(r).toEqual({
      status: "mismatch",
      atSlot: 2_000n,
      differences: [
        { owner: B, indexed: 200_000n, explorer: 250_000n },
        { owner: C, indexed: 50_000n, explorer: 0n },
        { owner: key(74), indexed: 0n, explorer: 1n },
      ].sort((x, y) => (x.owner < y.owner ? -1 : 1)),
    });
  });

  it("refuses to compare beyond the index, or a malformed export", () => {
    expect(compareWithExplorer(asset, events, throughSlot, { slot: 2_001n, balances: {} })).toMatchObject({ status: "not_comparable", reason: "explorer_after_index" });
    expect(compareWithExplorer(asset, events, throughSlot, { slot: 10n, balances: { "not-an-address": "1" } })).toMatchObject({ status: "not_comparable", reason: "invalid_export" });
    expect(compareWithExplorer(asset, events, throughSlot, { slot: 10n, balances: { [A]: "-5" } })).toMatchObject({ status: "not_comparable", reason: "invalid_export" });
  });
});
