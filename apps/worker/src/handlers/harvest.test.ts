import { describe, expect, it } from "vitest";
import type { AnchorUpdate, HarvestRow } from "@metafarm/db";
import { NonRetryableJobError, harvestChainId } from "@metafarm/domain";
import { createLogger } from "@metafarm/observability";
import { harvestAnchorHandler, type AnchorStore, type HarvestRegistryClient } from "./harvest";

type Hex = `0x${string}`;
const log = createLogger({ service: "test", level: "silent" });
const BATCH = "0b3c5d7e-9f1a-2b4c-6d8e-0f1a2b3c4d5e";
const HASH = "a".repeat(64);

function row(over: Partial<HarvestRow> = {}): HarvestRow {
  return {
    id: BATCH,
    tenant_id: "t",
    farm_id: "f",
    code: "HB7K3Q9X2M",
    crop_name: "Pistachio",
    parcel_label: null,
    harvested_on: "2026-09-20",
    quantity: "10.000",
    unit: "kg",
    quality_grade: null,
    notes: null,
    task_id: null,
    public_record: {} as HarvestRow["public_record"],
    record_hash: HASH,
    anchor_status: "pending",
    anchor_attempt: 1,
    anchor_chain_id: null,
    anchor_contract: null,
    anchor_tx_hash: null,
    anchor_block: null,
    anchored_at: null,
    anchor_error: null,
    voided_at: null,
    void_reason: null,
    void_anchor_status: null,
    void_tx_hash: null,
    recorded_by: null,
    recorded_by_name: null,
    created_at: "2026-09-21T00:00:00Z",
    ...over,
  };
}

function store(initial: HarvestRow) {
  const saves: { action: string; u: AnchorUpdate }[] = [];
  const s: AnchorStore = {
    load: async () => initial,
    save: async (_t, _b, action, u) => {
      saves.push({ action, u });
    },
  };
  return { s, saves };
}

/** An in-memory registry with the contract's rules. */
function chain(opts: { wait?: "timeout" | "reverted" } = {}) {
  const entries = new Map<string, { recordHash: string; recordedAt: bigint; voidedAt: bigint }>();
  const sent: string[] = [];
  let n = 0;
  const c: HarvestRegistryClient = {
    chainId: 84532,
    address: "0x" + "1".repeat(40),
    entryOf: async (id) => entries.get(id) ?? { recordHash: "0x" + "0".repeat(64), recordedAt: 0n, voidedAt: 0n },
    record: async (id, hash) => {
      sent.push(`record:${id}`);
      // A slow or reverted transaction has not changed the registry (yet).
      if (!opts.wait) entries.set(id, { recordHash: hash, recordedAt: 1n, voidedAt: 0n });
      return `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
    },
    voidBatch: async (id) => {
      sent.push(`void:${id}`);
      const e = entries.get(id)!;
      entries.set(id, { ...e, voidedAt: 2n });
      return `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
    },
    waitFor: async () => (opts.wait === "timeout" ? "timeout" : { status: opts.wait === "reverted" ? "reverted" : "success", blockNumber: 42n }),
  };
  return { c, entries, sent };
}

const job = (action: "record" | "void" = "record") => ({ tenantId: "t", batchId: BATCH, action, attempt: 1 });
const ctx = (attempt = 1) => ({ log, attempt, jobId: "1" });

describe("harvest anchoring", () => {
  it("marks batches not configured when there is no registry", async () => {
    const { s, saves } = store(row());
    await harvestAnchorHandler(s, undefined, { maxAttempts: 3 })(job(), ctx());
    expect(saves).toEqual([{ action: "record", u: { status: "not_configured" } }]);
  });

  it("registers the fingerprint and records the block", async () => {
    const { s, saves } = store(row());
    const { c, entries } = chain();
    await harvestAnchorHandler(s, c, { maxAttempts: 3 })(job(), ctx());
    expect(entries.get(harvestChainId(BATCH))!.recordHash).toBe(`0x${HASH}`);
    expect(saves.map((x) => x.u.status)).toEqual(["submitted", "confirmed"]);
    expect(saves[1]!.u).toMatchObject({ block: 42n, chainId: 84532 });
  });

  it("never sends a second transaction for a batch already registered", async () => {
    const { s, saves } = store(row({ anchor_status: "pending" }));
    const { c, entries, sent } = chain();
    entries.set(harvestChainId(BATCH), { recordHash: `0x${HASH}`, recordedAt: 1n, voidedAt: 0n });
    await harvestAnchorHandler(s, c, { maxAttempts: 3 })(job(), ctx());
    expect(sent).toEqual([]);
    expect(saves.at(-1)!.u.status).toBe("confirmed");
  });

  it("waits for an already-sent transaction instead of resending", async () => {
    const tx = `0x${"9".repeat(64)}`;
    const { s } = store(row({ anchor_status: "submitted", anchor_tx_hash: tx }));
    const { c, sent } = chain();
    await harvestAnchorHandler(s, c, { maxAttempts: 3 })(job(), ctx());
    expect(sent).toEqual([]);
  });

  it("fails permanently if the registry holds a different fingerprint", async () => {
    const { s, saves } = store(row());
    const { c, entries } = chain();
    entries.set(harvestChainId(BATCH), { recordHash: `0x${"b".repeat(64)}`, recordedAt: 1n, voidedAt: 0n });
    await expect(harvestAnchorHandler(s, c, { maxAttempts: 3 })(job(), ctx())).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(saves.at(-1)!.u).toMatchObject({ status: "failed" });
  });

  it("retries when the transaction is slow, and shows failure after the last attempt", async () => {
    const { s, saves } = store(row());
    const { c } = chain({ wait: "timeout" });
    await expect(harvestAnchorHandler(s, c, { maxAttempts: 3 })(job(), ctx(1))).rejects.toThrow(/not confirmed yet/);
    expect(saves.at(-1)!.u.status).toBe("submitted");
    await expect(harvestAnchorHandler(s, c, { maxAttempts: 3 })(job(), ctx(3))).rejects.toThrow(/not confirmed yet/);
    expect(saves.at(-1)!.u.status).toBe("failed");
  });

  it("registers a void after the batch itself", async () => {
    const { s, saves } = store(row({ voided_at: "2026-09-22T00:00:00Z", void_reason: "recorded twice", void_anchor_status: "not_configured" }));
    const { c, sent } = chain();
    await harvestAnchorHandler(s, c, { maxAttempts: 3 })(job(), ctx());
    expect(sent).toEqual([`record:${harvestChainId(BATCH)}`, `void:${harvestChainId(BATCH)}`]);
    expect(saves.filter((x) => x.action === "void").map((x) => x.u.status)).toEqual(["submitted", "confirmed"]);
  });
});
