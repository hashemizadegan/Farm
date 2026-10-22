/**
 * Y0 (D-16 option A): the ownership index refuses RPC batches without a verified cluster identity. These unit
 * tests need no database: the pool throws if touched, which proves every refusal here happens before anything
 * is read or written (no events stored, no cursor moved). Guards use the real verifyClusterIdentity with
 * stubbed getGenesisHash answers, so the results are deterministic.
 */
import { describe, expect, it } from "vitest";
import { SOLANA_GENESIS_HASHES, verifyClusterIdentity } from "@metafarm/chain";
import type { Pool } from "@metafarm/db";
import type { OwnershipEventSource, OwnershipIndexJob } from "@metafarm/domain";
import { OWNERSHIP_IDENTITY_ERROR_CODES, OwnershipSourceIdentityError, ownershipIndexHandler, registerOwnershipSource, type SourceIdentityGuard } from "./handlers/ownership-index";

const KEY = "not-a-real-key-123";
const URL_WITH_KEY = `https://rpc.devnet.invalid/v1/${KEY}?api-key=${KEY}`;
const DEVNET = SOLANA_GENESIS_HASHES["solana-devnet"];
const MAINNET = SOLANA_GENESIS_HASHES["solana-mainnet"];

/** A pool that fails the test if anything touches it. */
const untouchedPool = new Proxy({}, { get: (_t, p) => (p === "then" ? undefined : () => { throw new Error(`the database was touched (${String(p)})`); }) }) as unknown as Pool;

/** A guard over the real verifier, answering getGenesisHash from a fixed script. */
function guard(answers: ({ result: string } | { status: number })[], network: "solana-devnet" | "solana-mainnet" = "solana-devnet"): SourceIdentityGuard & { calls: number } {
  const g = {
    calls: 0,
    verifiedBy: "worker:ownership-index",
    verify: () => {
      const a = answers[Math.min(g.calls++, answers.length - 1)]!;
      return verifyClusterIdentity({
        url: URL_WITH_KEY,
        network,
        label: "RPC",
        attempts: 1,
        timeoutMs: 50,
        fetchImpl: async () => ("status" in a ? { ok: false, status: a.status, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: a.result }) }),
      });
    },
  };
  return g;
}

function rpcSource(): OwnershipEventSource & { reads: number } {
  const s = {
    name: "rpc" as const,
    reads: 0,
    covers: () => true,
    eventsAfter: async () => {
      s.reads++;
      return { events: [], throughSlot: 10n };
    },
  };
  return s;
}

const job: OwnershipIndexJob = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", assetId: "So11111111111111111111111111111111111111112", bucket: "b" };
const logs: { level: string; obj: unknown; msg: string }[] = [];
const log = { info: () => undefined, warn: () => undefined, debug: () => undefined, error: (obj: unknown, msg: string) => void logs.push({ level: "error", obj, msg }) };
const ctx = { log, attempt: 1, jobId: "t" } as never;

async function refusal(p: Promise<unknown>): Promise<OwnershipSourceIdentityError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OwnershipSourceIdentityError);
    const err = e as OwnershipSourceIdentityError;
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(KEY);
    return err;
  }
  throw new Error("expected a refusal");
}

describe("ownership index: cluster identity refusals (no database touched)", () => {
  it("has a fixed set of error codes", () => {
    expect(OWNERSHIP_IDENTITY_ERROR_CODES).toEqual(["identity_not_configured", "cluster_mismatch", "cluster_unavailable", "cluster_invalid_response", "network_mismatch", "identity_changed"]);
  });

  it("refuses an RPC source with no identity guard", async () => {
    const src = rpcSource();
    const e = await refusal(ownershipIndexHandler(untouchedPool, src)(job, ctx));
    expect([e.code, e.details]).toEqual(["identity_not_configured", { network: "solana-devnet", endpoint: null, expectedGenesisHash: null, actualGenesisHash: null }]);
    expect(src.reads).toBe(0);
  });

  it("refuses a mismatched cluster before reading anything, with expected and actual genesis hashes", async () => {
    const src = rpcSource();
    const g = guard([{ result: MAINNET }]);
    logs.length = 0;
    const e = await refusal(ownershipIndexHandler(untouchedPool, src, g)(job, ctx));
    expect([e.code, e.details]).toEqual(["cluster_mismatch", { network: "solana-devnet", endpoint: "https://rpc.devnet.invalid/[redacted]", expectedGenesisHash: DEVNET, actualGenesisHash: MAINNET }]);
    expect([src.reads, g.calls]).toEqual([0, 1]);
    // A structured log entry with the stable code (and no credential).
    expect(logs).toHaveLength(1);
    expect(logs[0]!.obj).toMatchObject({ code: "cluster_mismatch", expectedGenesisHash: DEVNET, actualGenesisHash: MAINNET });
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });

  it("refuses an unavailable or non-Solana endpoint", async () => {
    expect((await refusal(ownershipIndexHandler(untouchedPool, rpcSource(), guard([{ status: 503 }]))(job, ctx))).code).toBe("cluster_unavailable");
    expect((await refusal(ownershipIndexHandler(untouchedPool, rpcSource(), guard([{ result: "nope" }]))(job, ctx))).code).toBe("cluster_invalid_response");
  });

  it("refuses a source verified for another network than the job's", async () => {
    const e = await refusal(ownershipIndexHandler(untouchedPool, rpcSource(), guard([{ result: MAINNET }], "solana-mainnet"))(job, ctx));
    expect([e.code, e.details.actualGenesisHash]).toEqual(["network_mismatch", MAINNET]);
  });

  it("registration refuses a mismatched cluster without touching the database", async () => {
    const e = await refusal(registerOwnershipSource(untouchedPool, guard([{ result: MAINNET }]), "solana-devnet"));
    expect(e.code).toBe("cluster_mismatch");
  });

  it("fixture sources need no guard and are not verified (simulation-only data)", async () => {
    const fixture = { name: "fixture" as const, covers: () => false, eventsAfter: async () => ({ events: [], throughSlot: 0n }) };
    expect(await ownershipIndexHandler(untouchedPool, fixture)(job, ctx)).toEqual({ status: "skipped", reason: "not_covered" });
  });
});
