import { getHarvest, setAnchorState, withTenant, type AnchorUpdate, type HarvestRow, type Pool } from "@metafarm/db";
import { NonRetryableJobError, harvestChainId, type HarvestAnchorJob } from "@metafarm/domain";
import type { Handler } from "../runner";

type Hex = `0x${string}`;

/** HarvestRegistry access behind an interface; the viem implementation is in ../harvest-registry.ts. */
export interface HarvestRegistryClient {
  chainId: number;
  address: string;
  entryOf(batchId: Hex): Promise<{ recordHash: string; recordedAt: bigint; voidedAt: bigint }>;
  record(batchId: Hex, recordHash: Hex): Promise<Hex>;
  voidBatch(batchId: Hex, reasonHash: Hex): Promise<Hex>;
  /** Waits for the transaction; "timeout" when it is not confirmed in time (the job retries later). */
  waitFor(txHash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint } | "timeout">;
}

export interface AnchorStore {
  load(tenantId: string, batchId: string): Promise<HarvestRow | undefined>;
  save(tenantId: string, batchId: string, action: "record" | "void", update: AnchorUpdate): Promise<void>;
}

export function dbAnchorStore(pool: Pool): AnchorStore {
  return {
    load: (tenantId, batchId) => withTenant(pool, tenantId, (tx) => getHarvest(tx, batchId)),
    save: (tenantId, batchId, action, u) => withTenant(pool, tenantId, (tx) => setAnchorState(tx, batchId, action, u)),
  };
}

async function sha256Hex(text: string): Promise<Hex> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `0x${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

class NotYetConfirmed extends Error {
  constructor(tx: string) {
    super(`transaction ${tx} not confirmed yet`);
  }
}

/**
 * Registers a batch's fingerprint (and, if voided, the void) in HarvestRegistry.
 *
 * Safe to retry: the registry is read first, and an already-sent transaction
 * is awaited instead of being sent again. A registry entry with a different
 * fingerprint is a permanent failure (never overwritten; the contract forbids it).
 */
export function harvestAnchorHandler(store: AnchorStore, chain: HarvestRegistryClient | undefined, opts: { maxAttempts: number }): Handler<HarvestAnchorJob> {
  return async (job, { log, attempt }) => {
    const h = await store.load(job.tenantId, job.batchId);
    if (!h) throw new NonRetryableJobError("harvest batch not found");
    if (!chain) {
      await store.save(job.tenantId, job.batchId, job.action, { status: "not_configured" });
      return { skipped: "registry not configured" };
    }
    const id = harvestChainId(h.id);
    const expected = `0x${h.record_hash}` as Hex;
    const where = { chainId: chain.chainId, contract: chain.address };

    try {
      // 1. The batch itself.
      if (h.anchor_status !== "confirmed") {
        const entry = await chain.entryOf(id);
        if (entry.recordedAt > 0n) {
          if (entry.recordHash.toLowerCase() !== expected) {
            await store.save(job.tenantId, job.batchId, "record", { status: "failed", ...where, error: "the registry holds a different fingerprint for this batch" });
            throw new NonRetryableJobError("registry fingerprint mismatch");
          }
          await store.save(job.tenantId, job.batchId, "record", { status: "confirmed", ...where });
        } else {
          const tx = h.anchor_status === "submitted" && h.anchor_tx_hash ? (h.anchor_tx_hash as Hex) : await chain.record(id, expected);
          await store.save(job.tenantId, job.batchId, "record", { status: "submitted", ...where, txHash: tx, error: null });
          log.info({ tx }, "harvest registration sent");
          const r = await chain.waitFor(tx);
          if (r === "timeout") throw new NotYetConfirmed(tx);
          if (r.status === "reverted") {
            // Lost a race with an earlier transaction for the same batch? Then the entry is already there.
            const again = await chain.entryOf(id);
            if (again.recordedAt > 0n && again.recordHash.toLowerCase() === expected) {
              await store.save(job.tenantId, job.batchId, "record", { status: "confirmed", ...where, error: null });
            } else {
              await store.save(job.tenantId, job.batchId, "record", { status: "failed", ...where, error: `transaction ${tx} reverted` });
              throw new NonRetryableJobError("registration reverted");
            }
          } else {
            await store.save(job.tenantId, job.batchId, "record", { status: "confirmed", ...where, txHash: tx, block: r.blockNumber, error: null });
          }
        }
      }

      // 2. Its void, if any (also picked up here when the void came in while registration was pending).
      if (h.voided_at && h.void_anchor_status !== "confirmed") {
        const entry = await chain.entryOf(id);
        if (entry.voidedAt > 0n) {
          await store.save(job.tenantId, job.batchId, "void", { status: "confirmed" });
        } else {
          const tx = h.void_anchor_status === "submitted" && h.void_tx_hash ? (h.void_tx_hash as Hex) : await chain.voidBatch(id, await sha256Hex(h.void_reason ?? ""));
          await store.save(job.tenantId, job.batchId, "void", { status: "submitted", txHash: tx, error: null });
          const r = await chain.waitFor(tx);
          if (r === "timeout") throw new NotYetConfirmed(tx);
          await store.save(job.tenantId, job.batchId, "void", r.status === "success" ? { status: "confirmed", error: null } : { status: "failed", error: `transaction ${tx} reverted` });
        }
      }
      return { registered: true };
    } catch (err) {
      if (!(err instanceof NonRetryableJobError) && attempt >= opts.maxAttempts) {
        // Out of retries: show it as failed so a manager can retry from the app.
        await store
          .save(job.tenantId, job.batchId, h.anchor_status === "confirmed" ? "void" : "record", { status: "failed", error: (err as Error).message })
          .catch(() => undefined);
      }
      throw err;
    }
  };
}
