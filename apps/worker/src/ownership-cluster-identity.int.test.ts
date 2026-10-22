/**
 * Y0 (D-16 option A) against the database: cluster identity registration, per-batch verification, binding of
 * events and cursors, and fail-closed refusals that write nothing and leave the cursor where it was.
 * getGenesisHash is stubbed, so every answer is deterministic.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, insertOwnershipEvents, migrateUp, readOwnershipIndex, registerOwnershipSourceIdentity, withSystem, type Pool } from "@metafarm/db";
import { SOLANA_GENESIS_HASHES, base58Encode, verifyClusterIdentity } from "@metafarm/chain";
import type { ChainAssetRef, OwnershipEvent, OwnershipEventSource, OwnershipIndexJob } from "@metafarm/domain";
import { createLogger } from "@metafarm/observability";
import { OwnershipSourceIdentityError, ownershipIndexHandler, registerOwnershipSource, type SourceIdentityGuard } from "./handlers/ownership-index";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const log = createLogger({ service: "test", level: "silent" });
const ctx = { log, attempt: 1, jobId: "t" };
const KEY = "never-store-this-key";
const DEVNET = SOLANA_GENESIS_HASHES["solana-devnet"];
const MAINNET = SOLANA_GENESIS_HASHES["solana-mainnet"];

// Unique per run: the index and the identities are global tables shared with other test files.
const b58 = (n: number) => base58Encode(randomBytes(n));
const host = `rpc-${randomBytes(4).toString("hex")}.devnet.invalid`;
const asset: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: b58(32) };
const job: OwnershipIndexJob = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", assetId: asset.id, bucket: "b" };
const ev = (slot: bigint, amount = 1n): OwnershipEvent => ({ asset, kind: "mint", from: null, to: b58(32), amount, slot, txIndex: 0, ixIndex: 0, signature: b58(64) });

/** A guard over the real verifier; `answer` decides what getGenesisHash returns next. */
function guard(h = host) {
  const g = {
    calls: 0,
    answer: DEVNET as string,
    verifiedBy: "worker:ownership-index",
    host: h,
    verify: () => {
      g.calls++;
      const result = g.answer;
      return verifyClusterIdentity({ url: `https://${g.host}/v2/${KEY}?api-key=${KEY}`, network: "solana-devnet", label: "RPC", attempts: 1, timeoutMs: 50, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) }) });
    },
  };
  return g satisfies SourceIdentityGuard;
}

/** An RPC source serving a fixed list of events up to `through`; counts reads. */
function rpcSource(events: OwnershipEvent[], through: bigint) {
  const s = {
    name: "rpc" as const,
    reads: 0,
    through,
    events,
    covers: (a: ChainAssetRef) => a.id === asset.id,
    eventsAfter: async (_a: ChainAssetRef, after: bigint | null) => {
      s.reads++;
      return { events: s.events.filter((e) => (after === null || e.slot > after) && e.slot <= s.through), throughSlot: s.through };
    },
  };
  return s satisfies OwnershipEventSource;
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as OwnershipSourceIdentityError).code ?? (e as { code?: string }).code ?? (e as Error).name;
  }
  return "no error";
}

d("ownership index: verified cluster identity (Y0)", () => {
  let pool: Pool;
  const identityRows = () => pool.query(`SELECT id::text, network, genesis_hash, endpoint_scheme, endpoint_host, verified_by, verified_at, last_verified_at FROM ownership_source_identities WHERE endpoint_host = $1`, [host]);
  const state = async () => {
    const events = await pool.query<{ n: number; bound: number }>(`SELECT count(*)::int AS n, count(source_identity_id)::int AS bound FROM chain_ownership_events WHERE asset_id = $1`, [asset.id]);
    const cursor = await pool.query<{ s: string; id: string | null }>(`SELECT indexed_through_slot::text AS s, source_identity_id::text AS id FROM chain_ownership_cursors WHERE asset_id = $1`, [asset.id]);
    return { events: events.rows[0]!.n, bound: events.rows[0]!.bound, cursor: cursor.rows[0]?.s ?? null, cursorIdentity: cursor.rows[0]?.id ?? null };
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("registration records the identity as network, genesis hash, scheme and host only; registering again keeps it", async () => {
    const g = guard();
    const first = await registerOwnershipSource(pool, g, "solana-devnet");
    expect({ network: first.network, genesisHash: first.genesisHash, endpointScheme: first.endpointScheme, endpointHost: first.endpointHost, verifiedBy: first.verifiedBy }).toEqual({
      network: "solana-devnet",
      genesisHash: DEVNET,
      endpointScheme: "https",
      endpointHost: host,
      verifiedBy: "worker:ownership-index",
    });
    const again = await registerOwnershipSource(pool, { ...g, verifiedBy: "worker:other" }, "solana-devnet");
    expect(again.id).toBe(first.id);
    expect(again.verifiedBy).toBe("worker:ownership-index"); // the first verifier is kept
    expect(again.lastVerifiedAt.getTime()).toBeGreaterThanOrEqual(first.lastVerifiedAt.getTime());
    const rows = (await identityRows()).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });

  it("registration refuses a mismatched cluster and records nothing", async () => {
    const g = guard(`mismatch-${host}`);
    g.answer = MAINNET;
    expect(await code(registerOwnershipSource(pool, g, "solana-devnet"))).toBe("cluster_mismatch");
    expect((await pool.query(`SELECT 1 FROM ownership_source_identities WHERE endpoint_host = $1`, [`mismatch-${host}`])).rowCount).toBe(0);
  });

  it("verifies before and after reading each batch, and binds the events and the cursor to the identity", async () => {
    const g = guard();
    const src = rpcSource([ev(100n), ev(200n)], 150n);
    expect(await ownershipIndexHandler(pool, src, g)(job, ctx)).toEqual({ status: "indexed", inserted: 1, indexedThroughSlot: "150" });
    expect(g.calls).toBe(2);
    src.through = 250n;
    expect(await ownershipIndexHandler(pool, src, g)(job, ctx)).toEqual({ status: "indexed", inserted: 1, indexedThroughSlot: "250" });
    expect(g.calls).toBe(4); // two verifications per batch
    const id = (await identityRows()).rows[0]!.id;
    expect(await state()).toEqual({ events: 2, bound: 2, cursor: "250", cursorIdentity: id });
    // The reader serves the bound index.
    expect((await readOwnershipIndex(pool, asset))!.indexedThroughSlot).toBe(250n);
  });

  it("a mismatch before the batch writes nothing, reads nothing and leaves the cursor", async () => {
    const before = await state();
    const g = guard();
    g.answer = MAINNET;
    const src = rpcSource([ev(300n)], 400n);
    const e = (await ownershipIndexHandler(pool, src, g)(job, ctx).catch((x: unknown) => x)) as OwnershipSourceIdentityError;
    expect(e).toBeInstanceOf(OwnershipSourceIdentityError);
    expect([e.code, e.details.expectedGenesisHash, e.details.actualGenesisHash]).toEqual(["cluster_mismatch", DEVNET, MAINNET]);
    expect(src.reads).toBe(0);
    expect(await state()).toEqual(before);
  });

  it("a cluster change during the batch (after reading) writes nothing and leaves the cursor", async () => {
    const before = await state();
    const g = guard();
    const src = rpcSource([ev(300n)], 400n);
    const verify = g.verify;
    let n = 0;
    const flipping = {
      ...g,
      verify: () => {
        if (++n === 2) g.answer = MAINNET; // the endpoint now serves another cluster
        return verify();
      },
    };
    expect(await code(ownershipIndexHandler(pool, src, flipping)(job, ctx))).toBe("cluster_mismatch");
    expect(src.reads).toBe(1);
    expect(await state()).toEqual(before);
    // Another host for the same cluster between the two checks is refused too.
    let m = 0;
    const other = guard(`other-${host}`);
    const moving = { ...g, verify: () => (++m === 2 ? other.verify() : guard().verify()) };
    expect(await code(ownershipIndexHandler(pool, src, moving)(job, ctx))).toBe("identity_changed");
    expect(await state()).toEqual(before);
  });

  it("an RPC source without a guard, or verified for another network, writes nothing", async () => {
    const before = await state();
    expect(await code(ownershipIndexHandler(pool, rpcSource([ev(300n)], 400n))(job, ctx))).toBe("identity_not_configured");
    const mainnetGuard = { verifiedBy: "worker:ownership-index", verify: () => verifyClusterIdentity({ url: `https://${host}`, network: "solana-mainnet", label: "RPC", attempts: 1, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: MAINNET }) }) }) };
    expect(await code(ownershipIndexHandler(pool, rpcSource([ev(300n)], 400n), mainnetGuard)(job, ctx))).toBe("network_mismatch");
    expect(await state()).toEqual(before);
  });

  it("the database refuses unbound RPC rows, fixture rows with an identity, and identities of another network", async () => {
    const other: ChainAssetRef = { ...asset, id: b58(32) };
    const row = { ...ev(1n), asset: other };
    expect(await code(withSystem(pool, (tx) => insertOwnershipEvents(tx, [row], "rpc")))).toBe("23514");
    const id = BigInt((await identityRows()).rows[0]!.id);
    expect(await code(withSystem(pool, (tx) => insertOwnershipEvents(tx, [row], "fixture", id)))).toBe("23514");
    const mainnetAsset = { ...row, asset: { ...other, network: "solana-mainnet" as const } };
    expect(await code(withSystem(pool, (tx) => insertOwnershipEvents(tx, [mainnetAsset], "rpc", id)))).toBe("23503");
    expect(await code(withSystem(pool, (tx) => registerOwnershipSourceIdentity(tx, { network: "solana-devnet", genesisHash: MAINNET, endpointScheme: "https", endpointHost: host, verifiedBy: "w" })))).toBe("23514");
    expect(await code(withSystem(pool, (tx) => registerOwnershipSourceIdentity(tx, { network: "solana-devnet", genesisHash: DEVNET, endpointScheme: "https", endpointHost: `${host}/path`, verifiedBy: "w" })))).toBe("23514");
  });
});
