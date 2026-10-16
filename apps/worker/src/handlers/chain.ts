import { getChainCursor, markReorged, setChainCursor, upsertChainLogs, withSystem, type ChainLog, type Pool } from "@metafarm/db";
import type { ChainEventIndexingJob } from "@metafarm/domain";
import type { Handler } from "../runner";

/**
 * Chain access behind an interface. The viem implementation lives in
 * ../chain-reader.ts; tests use an in-memory fake.
 */
export interface ChainReader {
  latestBlock(): Promise<bigint>;
  blockHash(n: bigint): Promise<string | undefined>;
  getLogs(contract: string, from: bigint, to: bigint): Promise<Omit<ChainLog, "chainId" | "contractAddress">[]>;
}

export interface ChainIndexerOptions {
  chainId: number;
  confirmations: number;
  /** Max blocks per run, to bound RPC load. */
  maxRange: bigint;
  /** How far back to rewind when a reorg is detected. */
  reorgRewind: bigint;
}

/**
 * Indexes contract events idempotently:
 *  - events are keyed by (chain, tx hash, log index) and upserted,
 *  - only blocks at least `confirmations` deep are marked confirmed,
 *  - before advancing, the stored cursor's block hash is compared with the
 *    chain; on mismatch (reorg) events after the rewind point are marked
 *    `removed` and re-indexed.
 * The database, not the chain indexer, is the source of truth for the UI; the
 * UI must label unconfirmed events as pending.
 */
export function chainIndexHandler(pool: Pool, reader: ChainReader, opts: ChainIndexerOptions): Handler<ChainEventIndexingJob> {
  return async (job, { log }) => {
    const contract = job.contractAddress.toLowerCase();
    const head = await reader.latestBlock();
    const safeHead = head - BigInt(opts.confirmations);
    if (safeHead < 0n) return { indexed: 0, reason: "chain shorter than confirmation depth" };

    return withSystem(pool, async (tx) => {
      const cursor = await getChainCursor(tx, opts.chainId, contract);
      let from = cursor ? cursor.blockNumber + 1n : BigInt(job.fromBlock);

      if (cursor) {
        const onChain = await reader.blockHash(cursor.blockNumber);
        if (onChain && onChain !== cursor.blockHash) {
          const rewindTo = cursor.blockNumber > opts.reorgRewind ? cursor.blockNumber - opts.reorgRewind : 0n;
          const removed = await markReorged(tx, opts.chainId, contract, rewindTo);
          log.warn({ at: cursor.blockNumber.toString(), rewindTo: rewindTo.toString(), removed }, "reorg detected; rewinding");
          from = rewindTo;
        }
      }

      // Scheduled runs pass "latest:<bucket>" so each run has its own idempotency key.
      const requestedTo = job.toBlock.startsWith("latest") ? safeHead : BigInt(job.toBlock);
      let to = safeHead < requestedTo ? safeHead : requestedTo;
      if (to - from + 1n > opts.maxRange) to = from + opts.maxRange - 1n;
      if (to < from) return { indexed: 0, reason: "up to date" };

      const logs = await reader.getLogs(contract, from, to);
      await upsertChainLogs(
        tx,
        logs.map((l) => ({ ...l, chainId: opts.chainId, contractAddress: contract })),
        true,
      );
      const toHash = await reader.blockHash(to);
      if (!toHash) throw new Error(`block ${to} not available from RPC`);
      await setChainCursor(tx, opts.chainId, contract, to, toHash);
      log.info({ from: from.toString(), to: to.toString(), logs: logs.length }, "chain range indexed");
      return { indexed: logs.length, from: from.toString(), to: to.toString() };
    });
  };
}
