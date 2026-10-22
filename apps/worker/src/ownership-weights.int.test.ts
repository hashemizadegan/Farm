/**
 * Y5 against the database: provenance precedence (D-17, F2 resolved as "verified RPC takes precedence"), the
 * history reader, and the weighted ownership input built from the verified index and the tenant's party wallets.
 * getGenesisHash is stubbed; nothing contacts a chain.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OwnershipProvenanceError,
  addWallet,
  createParty,
  createPool,
  createTenantWithOwner,
  loadWeightedOwnershipInput,
  migrateUp,
  readOwnershipIndex,
  readVerifiedOwnershipHistory,
  upsertUserBySubject,
  withSystem,
  withTenant,
  type Pool,
} from "@metafarm/db";
import { IndexOwnershipReader, SOLANA_GENESIS_HASHES, base58Encode, createFixtureEventSource, verifyClusterIdentity } from "@metafarm/chain";
import { type ChainAssetRef, type HoldingWeightError, type OwnershipEvent, type OwnershipIndexJob, weightedOwnershipProblems } from "@metafarm/domain";
import { createLogger } from "@metafarm/observability";
import { ownershipIndexHandler, type SourceIdentityGuard } from "./handlers/ownership-index";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const log = createLogger({ service: "test", level: "silent" });
const ctx = { log, attempt: 1, jobId: "t" };
const DEVNET = SOLANA_GENESIS_HASHES["solana-devnet"];
const b58 = (n: number) => base58Encode(randomBytes(n));
const host = `rpc-${randomBytes(4).toString("hex")}.weights.invalid`;
const guard: SourceIdentityGuard = {
  verifiedBy: "worker:ownership-index",
  verify: () => verifyClusterIdentity({ url: `https://${host}`, network: "solana-devnet", label: "RPC", attempts: 1, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ result: DEVNET }) }) }),
};
const newAsset = (): ChainAssetRef => ({ network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: b58(32) });
const jobOf = (a: ChainAssetRef): OwnershipIndexJob => ({ network: "solana-devnet", rail: "SOLANA_TOKEN_2022", assetId: a.id, bucket: "b" });
const ev = (a: ChainAssetRef, kind: OwnershipEvent["kind"], from: string | null, to: string | null, amount: bigint, slot: bigint): OwnershipEvent => ({ asset: a, kind, from, to, amount, slot, txIndex: 0, ixIndex: 0, signature: b58(64) });
const rpcSource = (a: ChainAssetRef, events: OwnershipEvent[], through: bigint) => ({
  name: "rpc" as const,
  covers: (x: ChainAssetRef) => x.id === a.id,
  eventsAfter: async (_x: ChainAssetRef, after: bigint | null) => ({ events: events.filter((e) => after === null || e.slot > after), throughSlot: through }),
});
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as HoldingWeightError | OwnershipProvenanceError).code ?? (e as Error).name;
  }
  return "no error";
}

d("ownership provenance and slot-weighted inputs (Y5)", () => {
  let pool: Pool;
  let tenantId: string;
  let user: string;
  const counts = async (a: ChainAssetRef) =>
    (await pool.query<{ fixture: number; rpc: number }>(`SELECT count(*) FILTER (WHERE source = 'fixture')::int AS fixture, count(*) FILTER (WHERE source = 'rpc')::int AS rpc FROM chain_ownership_events WHERE asset_id = $1`, [a.id])).rows[0]!;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
    const sfx = Math.random().toString(36).slice(2, 8);
    user = (await upsertUserBySubject(pool, { issuer: "test", subject: `y5-${sfx}` })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `y5-${sfx}`, name: "Y5", ownerUserId: user }));
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("F2: once a verified RPC history exists, fixture rows for the same asset are kept but never served", async () => {
    const a = newAsset();
    const [x, y] = [b58(32), b58(32)];
    // A fixture history first (simulation/demo data).
    await ownershipIndexHandler(pool, createFixtureEventSource([ev(a, "mint", null, x, 5n, 10n)], 50n))(jobOf(a), ctx);
    expect((await readVerifiedOwnershipHistory(pool, a))!.sourceKind).toBe("fixture");
    // A verified RPC batch: the fixture cursor does not count, so the source is read from the start; the cursor restarts.
    const r = await ownershipIndexHandler(pool, rpcSource(a, [ev(a, "mint", null, y, 9n, 20n)], 40n), guard)(jobOf(a), ctx);
    expect(r).toEqual({ status: "indexed", inserted: 1, indexedThroughSlot: "40" });
    const h = (await readVerifiedOwnershipHistory(pool, a))!;
    expect([h.sourceKind, h.indexedThroughSlot, h.sourceIdentity?.genesisHash, h.events.map((e) => e.to)]).toEqual(["rpc", 40n, DEVNET, [y]]);
    expect(await counts(a)).toEqual({ fixture: 1, rpc: 1 }); // nothing deleted
    // The twin reader applies the same rule.
    expect((await new IndexOwnershipReader((q) => readOwnershipIndex(pool, q)).holdersOf(a))!.holders).toEqual([{ owner: y, amount: 9n }]);
  });

  it("refuses a fixture batch for an asset with verified RPC history, writing nothing", async () => {
    const a = newAsset();
    await ownershipIndexHandler(pool, rpcSource(a, [ev(a, "mint", null, b58(32), 3n, 5n)], 30n), guard)(jobOf(a), ctx);
    const before = await counts(a);
    const fixture = createFixtureEventSource([ev(a, "mint", null, b58(32), 1n, 60n)], 100n);
    expect(await code(ownershipIndexHandler(pool, fixture)(jobOf(a), ctx))).toBe("fixture_after_verified_rpc");
    expect(await counts(a)).toEqual(before);
    expect((await readVerifiedOwnershipHistory(pool, a))!.indexedThroughSlot).toBe(30n);
  });

  it("fails closed on ambiguous provenance: a fixture cursor beside verified RPC events", async () => {
    const a = newAsset();
    await ownershipIndexHandler(pool, rpcSource(a, [ev(a, "mint", null, b58(32), 3n, 5n)], 30n), guard)(jobOf(a), ctx);
    // Only reachable by direct database edits (the indexer refuses it): the cursor relabelled as fixture.
    await pool.query(`UPDATE chain_ownership_cursors SET source = 'fixture', source_identity_id = NULL WHERE asset_id = $1`, [a.id]);
    expect(await code(readVerifiedOwnershipHistory(pool, a))).toBe("ambiguous_provenance");
    await expect(new IndexOwnershipReader((q) => readOwnershipIndex(pool, q)).holdersOf(a)).rejects.toBeInstanceOf(OwnershipProvenanceError);
  });

  it("builds the slot-weighted input from verified history: parties over their wallets, others unattributed", async () => {
    const a = newAsset();
    const [w1, w2, w3, player] = [b58(32), b58(32), b58(32), b58(32)];
    const [p1, p2] = await withTenant(pool, tenantId, async (tx) => {
      const one = await createParty(tx, { kind: "person", displayName: "Holder one", createdBy: user });
      const two = await createParty(tx, { kind: "organisation", displayName: "Holder two", createdBy: user });
      await addWallet(tx, one, "solana-devnet", w1);
      await addWallet(tx, one, "solana-devnet", w3);
      await addWallet(tx, two, "solana-devnet", w2);
      return [one, two];
    });
    const events = [ev(a, "mint", null, w1, 600n, 10n), ev(a, "mint", null, w2, 300n, 11n), ev(a, "mint", null, player, 100n, 12n), ev(a, "transfer", w1, w3, 100n, 150n)];
    await ownershipIndexHandler(pool, rpcSource(a, events, 300n), guard)(jobOf(a), ctx);
    const window = { startSlot: 100n, endSlot: 200n };
    const input = await loadWeightedOwnershipInput(pool, tenantId, { asset: a, window, simulation: false });
    const sorted = [
      { partyId: p1, wallets: [w1, w3].sort(), weight: 60_000n, pointInTimeUnits: 600n },
      { partyId: p2, wallets: [w2], weight: 30_000n, pointInTimeUnits: 300n },
    ].sort((x, y) => (x.partyId < y.partyId ? -1 : 1));
    expect(input.parties).toEqual(sorted);
    expect(input.unattributed).toEqual([{ holderKey: player, weight: 10_000n, pointInTimeUnits: 100n }]);
    expect([input.totalWeight, input.provenance.sourceKind, input.provenance.cursorSlot, input.provenance.sourceIdentity?.genesisHash]).toEqual([100_000n, "rpc", 300n, DEVNET]);
    expect(await weightedOwnershipProblems(input)).toEqual([]);
    // Deterministic: the same index and window give the same commitment.
    expect((await loadWeightedOwnershipInput(pool, tenantId, { asset: a, window, simulation: false })).commitment).toBe(input.commitment);
    // Another tenant has no parties for these wallets: everything is unattributed, the weights are unchanged.
    const other = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `y5o-${randomBytes(3).toString("hex")}`, name: "Other", ownerUserId: user }));
    const elsewhere = await loadWeightedOwnershipInput(pool, other, { asset: a, window, simulation: false });
    expect([elsewhere.parties.length, elsewhere.unattributed.length, elsewhere.totalWeight]).toEqual([0, 4, 100_000n]);
    // A window past the cursor is incomplete history.
    expect(await code(loadWeightedOwnershipInput(pool, tenantId, { asset: a, window: { startSlot: 100n, endSlot: 301n }, simulation: false }))).toBe("incomplete_history");
  });

  it("D-17: fixture history builds simulation inputs only; an unindexed asset is refused", async () => {
    const a = newAsset();
    await ownershipIndexHandler(pool, createFixtureEventSource([ev(a, "mint", null, b58(32), 7n, 1n)], 100n))(jobOf(a), ctx);
    const window = { startSlot: 0n, endSlot: 50n };
    expect(await code(loadWeightedOwnershipInput(pool, tenantId, { asset: a, window, simulation: false }))).toBe("fixture_in_real_cycle");
    const sim = await loadWeightedOwnershipInput(pool, tenantId, { asset: a, window, simulation: true });
    expect([sim.simulation, sim.provenance.sourceKind, sim.totalWeight]).toEqual([true, "fixture", 7n * 50n]);
    expect(await code(loadWeightedOwnershipInput(pool, tenantId, { asset: newAsset(), window, simulation: true }))).toBe("not_indexed");
  });

  it("party attribution is tenant-scoped: another tenant's wallets are invisible (RLS)", async () => {
    const other = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `y5r-${randomBytes(3).toString("hex")}`, name: "R", ownerUserId: user }));
    const mine = await withTenant(pool, tenantId, (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM party_wallets`));
    const theirs = await withTenant(pool, other, (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM party_wallets`));
    expect(mine.rows[0]!.n).toBeGreaterThan(0);
    expect(theirs.rows[0]!.n).toBe(0);
  });
});
