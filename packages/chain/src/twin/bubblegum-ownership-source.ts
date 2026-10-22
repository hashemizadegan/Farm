/**
 * Ownership events of Bubblegum V1 compressed NFTs, read from the finalized history of the asset's
 * Merkle tree. Read-only.
 *
 * - mint_v1 / mint_to_collection_v1: the asset and its first owner come from the leaf-schema event the
 *   mint emits through the noop program (the next leaf event after the mint instruction).
 * - transfer: the asset is leafAssetId(tree, nonce) from the instruction's arguments; from = leaf_owner,
 *   to = new_leaf_owner (instruction accounts).
 * - burn: the same asset derivation; from = leaf_owner.
 * - redeem of an indexed asset is refused (not supported), so nothing is stored for that window.
 *   cancel_redeem and decompress_v1 do not carry the leaf nonce; they can only follow a redeem of the
 *   same asset, which is already refused, so they are ignored like the instructions that do not change
 *   the owner (delegate, creator and collection verification, metadata updates).
 *
 * Fail closed on a wrong tree: on the first window (no cursor), the asset's mint must be in the tree's
 * history, otherwise nothing is stored and the asset stays not indexed, instead of looking unowned.
 * Bubblegum V2 instructions are not decoded; the platform mints V1. Same-slot ordering follows
 * getSignaturesForAddress (see token2022-ownership-source.ts).
 */
import { sha256 } from "@noble/hashes/sha2";
import type { ChainAssetRef, OwnershipEvent, OwnershipEventSource } from "@metafarm/domain";
import { BUBBLEGUM_PROGRAM, SPL_NOOP_PROGRAM, leafAssetId, parseLeafEvent } from "../solana/bubblegum";
import type { ExecutedInstruction, SolanaHistoryRpc } from "./solana-history-rpc";
import { OwnershipHistoryError } from "./token2022-ownership-source";

/** Anchor instruction discriminator: the first 8 bytes of SHA-256("global:<name>"). */
export const anchorDiscriminator = (name: string): Uint8Array => sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8);

const OPS = {
  mint_v1: "mint",
  mint_to_collection_v1: "mint",
  transfer: "transfer",
  burn: "burn",
  redeem: "unsupported",
} as const;
type Op = (typeof OPS)[keyof typeof OPS];
const DISCRIMINATORS: { op: Op; name: string; bytes: Uint8Array }[] = Object.entries(OPS).map(([name, op]) => ({ op, name, bytes: anchorDiscriminator(name) }));

function opOf(ix: ExecutedInstruction): { op: Op; name: string } | null {
  if (ix.programId !== BUBBLEGUM_PROGRAM || ix.data.length < 8) return null;
  const d = DISCRIMINATORS.find((x) => x.bytes.every((b, i) => ix.data[i] === b));
  return d ? { op: d.op, name: d.name } : null;
}

/** The nonce argument of transfer, burn and redeem: after root, data_hash and creator_hash (3 × 32 bytes). */
function nonceOf(ix: ExecutedInstruction): bigint {
  if (ix.data.length < 8 + 96 + 8) throw new OwnershipHistoryError("a Bubblegum instruction is too short for its arguments");
  return new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(8 + 96, true);
}

const account = (ix: ExecutedInstruction, i: number, what: string): string => {
  const a = ix.accounts[i];
  if (!a) throw new OwnershipHistoryError(`a Bubblegum instruction has no ${what} account`);
  return a;
};

/** Account positions of the V1 instructions (mpl-bubblegum account order). */
const TREE_INDEX = { transfer: 4, burn: 3, unsupported: 3 } as const;

/** The ownership events of one transaction for one compressed asset. Pure. */
export function bubblegumOwnershipEvents(asset: ChainAssetRef, tree: string, tx: { signature: string; slot: bigint; txIndex: number; instructions: readonly ExecutedInstruction[] }): OwnershipEvent[] {
  const events: OwnershipEvent[] = [];
  const push = (kind: OwnershipEvent["kind"], from: string | null, to: string | null) =>
    events.push({ asset, kind, from, to, amount: 1n, slot: tx.slot, txIndex: tx.txIndex, ixIndex: events.length, signature: tx.signature });
  let awaitingMintEvent = false;
  for (const ix of tx.instructions) {
    if (awaitingMintEvent && ix.programId === SPL_NOOP_PROGRAM) {
      awaitingMintEvent = false;
      let leaf;
      try {
        leaf = parseLeafEvent(ix.data);
      } catch {
        throw new OwnershipHistoryError(`transaction ${tx.signature}: a mint without a readable leaf event`);
      }
      if (leaf.assetId === asset.id) push("mint", null, leaf.owner);
      continue;
    }
    const op = opOf(ix);
    if (!op) continue;
    if (op.op === "mint") {
      if (account(ix, 3, "merkle tree") === tree) awaitingMintEvent = true;
      continue;
    }
    const ixTree = account(ix, TREE_INDEX[op.op], "merkle tree");
    if (ixTree !== tree) continue;
    if (leafAssetId(tree, nonceOf(ix)) !== asset.id) continue;
    if (op.op === "unsupported") throw new OwnershipHistoryError(`transaction ${tx.signature}: ${op.name} of ${asset.id} is not supported by the index`);
    if (op.op === "transfer") {
      const from = account(ix, 1, "leaf owner");
      const to = account(ix, 3, "new leaf owner");
      if (from !== to) push("transfer", from, to);
    } else push("burn", account(ix, 1, "leaf owner"), null);
  }
  if (awaitingMintEvent) throw new OwnershipHistoryError(`transaction ${tx.signature}: a mint without its leaf event`);
  return events;
}

export interface BubblegumSourceOptions {
  pageSize?: number;
  maxTransactions?: number;
}

/**
 * @param treeOf The Merkle tree that holds an asset, as the platform recorded it (null when unknown).
 */
export function createBubblegumOwnershipSource(
  rpc: SolanaHistoryRpc,
  network: "solana-devnet" | "solana-mainnet",
  treeOf: (assetId: string) => Promise<string | null>,
  opts: BubblegumSourceOptions = {},
): OwnershipEventSource {
  const pageSize = opts.pageSize ?? 1000;
  const maxTransactions = opts.maxTransactions ?? 10_000;
  return {
    name: "rpc",
    covers: (asset) => asset.rail === "SOLANA_BUBBLEGUM_CNFT" && asset.network === network,
    async eventsAfter(asset, afterSlot) {
      if (asset.rail !== "SOLANA_BUBBLEGUM_CNFT" || asset.network !== network) throw new OwnershipHistoryError(`this source reads Bubblegum on ${network} only`);
      const tree = await treeOf(asset.id);
      if (!tree) throw new OwnershipHistoryError(`no Merkle tree is recorded for ${asset.id}`);
      const throughSlot = await rpc.getFinalizedSlot();
      const window: { signature: string; slot: bigint; err: unknown }[] = [];
      let before: string | undefined;
      for (;;) {
        const page = await rpc.getSignaturesForAddress(tree, { before, limit: pageSize });
        let reachedCursor = false;
        for (const s of page) {
          if (afterSlot !== null && s.slot <= afterSlot) {
            reachedCursor = true;
            break;
          }
          if (s.slot <= throughSlot) window.push(s);
        }
        if (window.length > maxTransactions) throw new OwnershipHistoryError(`more than ${maxTransactions} transactions to read for tree ${tree}; raise the limit`);
        if (reachedCursor || page.length < pageSize) break;
        before = page[page.length - 1]!.signature;
      }
      window.reverse();
      const events: OwnershipEvent[] = [];
      let lastSlot: bigint | null = null;
      let txIndex = 0;
      for (const s of window) {
        txIndex = s.slot === lastSlot ? txIndex + 1 : 0;
        lastSlot = s.slot;
        if (s.err) continue;
        const tx = await rpc.getTransaction(s.signature);
        if (!tx) throw new OwnershipHistoryError(`finalized transaction ${s.signature} is not available from the node`);
        if (tx.slot !== s.slot) throw new OwnershipHistoryError(`transaction ${s.signature} is at slot ${tx.slot}, listed at ${s.slot}`);
        if (tx.err) continue;
        events.push(...bubblegumOwnershipEvents(asset, tree, { signature: s.signature, slot: s.slot, txIndex, instructions: tx.instructions }));
      }
      if (afterSlot === null && !events.some((e) => e.kind === "mint"))
        throw new OwnershipHistoryError(`the mint of ${asset.id} is not in the finalized history of tree ${tree}: wrong tree or not minted yet`);
      return { events, throughSlot };
    },
  };
}

/**
 * One source over several: the first that covers an asset answers for it. All members must be of one kind: a
 * fixture member behind an `rpc` name would have its events stored as RPC events and bound to the verified cluster
 * identity (Y0 review F2; D-17), so mixing kinds is refused, as is an empty list.
 */
export function combineOwnershipSources(...sources: OwnershipEventSource[]): OwnershipEventSource {
  if (sources.length === 0) throw new OwnershipHistoryError("no ownership sources to combine");
  const kinds = new Set(sources.map((s) => s.name));
  if (kinds.size > 1) throw new OwnershipHistoryError("fixture and RPC ownership sources cannot be combined (D-17)");
  const pick = (asset: ChainAssetRef) => sources.find((s) => s.covers(asset));
  return {
    name: sources[0]!.name,
    covers: (asset) => pick(asset) !== undefined,
    async eventsAfter(asset, afterSlot) {
      const s = pick(asset);
      if (!s) throw new OwnershipHistoryError(`no source covers ${asset.rail} on ${asset.network}`);
      return s.eventsAfter(asset, afterSlot);
    },
  };
}
