/**
 * Ownership events of a Token-2022 mint, read from finalized transactions. Read-only.
 *
 * Each finalized, successful transaction that touched the mint is reduced to its effect on holders: the
 * change in each owner's balance of that mint between the transaction's pre- and post-token balances.
 * Owners who lost tokens are paired with owners who gained them, in owner order, as transfers; a gain
 * left over is a mint, a loss left over is a burn. That is exactly the change in holdings, whatever
 * instructions caused it. Which instruction moved which tokens is not reconstructed.
 *
 * Ordering: getTransaction does not report a transaction's position in its block, so transactions in
 * the same slot are ordered as getSignaturesForAddress lists them. If that ever gives an impossible
 * order, the projection reports a conflict and the index reader fails closed; it cannot report a wrong
 * holder.
 */
import type { ChainAssetRef, OwnershipEvent, OwnershipEventSource } from "@metafarm/domain";
import { TOKEN_2022_PROGRAM } from "../solana/keys";
import type { SolanaHistoryRpc, TokenBalance } from "./solana-history-rpc";

export class OwnershipHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipHistoryError";
  }
}

/** The holder changes of one transaction for one mint, as ownership events. Pure. */
export function ownershipEventsFromBalances(
  asset: ChainAssetRef,
  tx: { signature: string; slot: bigint; txIndex: number; pre: readonly TokenBalance[]; post: readonly TokenBalance[] },
): OwnershipEvent[] {
  const net = new Map<string, bigint>();
  const add = (balances: readonly TokenBalance[], sign: 1n | -1n) => {
    for (const b of balances) {
      if (b.mint !== asset.id) continue;
      if (b.programId !== undefined && b.programId !== TOKEN_2022_PROGRAM) continue;
      if (!b.owner) throw new OwnershipHistoryError(`transaction ${tx.signature} has a token balance without an owner`);
      net.set(b.owner, (net.get(b.owner) ?? 0n) + sign * BigInt(b.amount));
    }
  };
  add(tx.pre, -1n);
  add(tx.post, 1n);
  const owners = [...net.keys()].sort();
  const losers = owners.filter((o) => net.get(o)! < 0n).map((o) => ({ owner: o, left: -net.get(o)! }));
  const gainers = owners.filter((o) => net.get(o)! > 0n).map((o) => ({ owner: o, left: net.get(o)! }));
  const events: OwnershipEvent[] = [];
  const push = (kind: OwnershipEvent["kind"], from: string | null, to: string | null, amount: bigint) =>
    events.push({ asset, kind, from, to, amount, slot: tx.slot, txIndex: tx.txIndex, ixIndex: events.length, signature: tx.signature });
  let i = 0;
  let j = 0;
  while (i < losers.length && j < gainers.length) {
    const amount = losers[i]!.left < gainers[j]!.left ? losers[i]!.left : gainers[j]!.left;
    push("transfer", losers[i]!.owner, gainers[j]!.owner, amount);
    losers[i]!.left -= amount;
    gainers[j]!.left -= amount;
    if (losers[i]!.left === 0n) i++;
    if (gainers[j]!.left === 0n) j++;
  }
  for (; j < gainers.length; j++) if (gainers[j]!.left > 0n) push("mint", null, gainers[j]!.owner, gainers[j]!.left);
  for (; i < losers.length; i++) if (losers[i]!.left > 0n) push("burn", losers[i]!.owner, null, losers[i]!.left);
  return events;
}

export interface Token2022SourceOptions {
  /** Signatures per page (getSignaturesForAddress allows up to 1000). */
  pageSize?: number;
  /** Refuse a window with more transactions than this rather than read part of it. */
  maxTransactions?: number;
}

export function createToken2022OwnershipSource(rpc: SolanaHistoryRpc, network: "solana-devnet" | "solana-mainnet", opts: Token2022SourceOptions = {}): OwnershipEventSource {
  const pageSize = opts.pageSize ?? 1000;
  const maxTransactions = opts.maxTransactions ?? 10_000;
  return {
    name: "rpc",
    covers: (asset) => asset.rail === "SOLANA_TOKEN_2022" && asset.network === network,
    async eventsAfter(asset, afterSlot) {
      if (asset.rail !== "SOLANA_TOKEN_2022" || asset.network !== network) throw new OwnershipHistoryError(`this source reads Token-2022 on ${network} only`);
      const throughSlot = await rpc.getFinalizedSlot();
      // Newest first; stop at the first signature at or before the cursor.
      const window: { signature: string; slot: bigint; err: unknown }[] = [];
      let before: string | undefined;
      for (;;) {
        const page = await rpc.getSignaturesForAddress(asset.id, { before, limit: pageSize });
        let reachedCursor = false;
        for (const s of page) {
          if (afterSlot !== null && s.slot <= afterSlot) {
            reachedCursor = true;
            break;
          }
          if (s.slot <= throughSlot) window.push(s);
        }
        if (window.length > maxTransactions) throw new OwnershipHistoryError(`more than ${maxTransactions} transactions to index for ${asset.id}; raise the limit`);
        if (reachedCursor || page.length < pageSize) break;
        before = page[page.length - 1]!.signature;
      }
      window.reverse(); // oldest first
      const events: OwnershipEvent[] = [];
      let lastSlot: bigint | null = null;
      let txIndex = 0;
      for (const s of window) {
        txIndex = s.slot === lastSlot ? txIndex + 1 : 0;
        lastSlot = s.slot;
        if (s.err) continue; // a failed transaction changes no balances
        const tx = await rpc.getTransaction(s.signature);
        if (!tx) throw new OwnershipHistoryError(`finalized transaction ${s.signature} is not available from the node`);
        if (tx.slot !== s.slot) throw new OwnershipHistoryError(`transaction ${s.signature} is at slot ${tx.slot}, listed at ${s.slot}`);
        if (tx.err) continue;
        events.push(...ownershipEventsFromBalances(asset, { signature: s.signature, slot: s.slot, txIndex, pre: tx.preTokenBalances, post: tx.postTokenBalances }));
      }
      return { events, throughSlot };
    },
  };
}
