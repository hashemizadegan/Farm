/**
 * The fault-injection harness (src/test/faults.ts) against the engine, with an honest scripted chain
 * underneath: F1 a mint that lands but is observed as expired; F2b a DAS proof with the wrong leaf.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addWallet,
  createCompressedRepresentation,
  createParty,
  createPool,
  createRegistrationOrder,
  migrateUp,
  recordScreening,
  setKyc,
  withSystem,
  withTenant,
  type Pool,
} from "@metafarm/db";
import type { ChainObservationPort, CompressedAssetPort } from "@metafarm/domain";
import { ENGINE_TEST_LOCK_WAIT_MS, takeEngineTestLock } from "../test/engine-lock";
import { b58, fakeChain, type FakeChain } from "../test/fake-solana";
import { firstTransactions, withExpiredObservations, withWrongProofs } from "../test/faults";
import { runTick, type EngineDeps, type Rails } from "./engine";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const log = { info: () => undefined, warn: () => undefined };

d("fault injection against the compressed-NFT engine", () => {
  let pool: Pool;
  let user: string;
  let approver: string;
  let unlock: (() => Promise<void>) | undefined;
  const sys = async <T>(sql: string, params: unknown[]) => withSystem(pool, async (tx) => (await tx.query(sql, params)).rows as T[]);

  /** A workspace with a compliant custodian; `register` adds an approved registration of a tree. */
  async function workspace() {
    const sfx = randomUUID().slice(0, 8);
    const tenant = (await sys<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1, $1) RETURNING id`, [`faults-${sfx}`]))[0]!.id;
    const farm = (await sys<{ id: string }>(`INSERT INTO farms (tenant_id, name) VALUES ($1, 'Grove') RETURNING id`, [tenant]))[0]!.id;
    const custody = b58();
    const party = await withTenant(pool, tenant, async (tx) => {
      const p = await createParty(tx, { kind: "organisation", displayName: "Custodian", jurisdiction: "AE", createdBy: user });
      await setKyc(tx, p, { status: "verified", reference: "kyc", expiresAt: new Date(Date.now() + 86_400_000 * 365), verifiedBy: user });
      const w = await addWallet(tx, p, "solana-devnet", custody);
      const clear = { provider: "p", outcome: "clear" as const, reasons: [], checkedAt: new Date(), recordedBy: user };
      await recordScreening(tx, { subject: "party", partyId: p }, { ...clear, providerReference: "s1" });
      await recordScreening(tx, { subject: "wallet", walletId: w }, { ...clear, providerReference: "s2" });
      return p;
    });
    const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      withTenant(pool, tenant, async (tx) => (await tx.query(sql, [tx.tenantId, ...params])).rows as T[]);
    const register = (name: string) =>
      withTenant(pool, tenant, async (tx) => {
        const asset = (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'tree', $3) RETURNING id`, [tx.tenantId, farm, name])).rows[0]!.id;
        const rep = await createCompressedRepresentation(tx, {
          assetId: asset,
          network: "solana-devnet",
          metadata: { name, symbol: "TREE", uri: `https://api.example.com/v1/public/rwa/cnft/${asset}`, commitment: { algorithm: "sha256", scheme: "metafarm-rwa-asset/1", hash: "0".repeat(64) }, commitmentSalt: "00".repeat(16) },
        });
        const order = await createRegistrationOrder(tx, { partyId: party, representationId: rep, custodianSolanaAddress: custody, createdBy: user });
        await tx.query(`UPDATE rwa_orders SET status = 'issuing', approved_by = $3, approved_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, order.id, approver]);
        return { rep, order: order.id, recon: order.reconciliationId };
      });
    const leaf = async (rep: string) =>
      (await q<{ status: string; merkle_tree: string | null; leaf_index: string | null; das_asset_id: string | null }>(`SELECT status, merkle_tree, leaf_index::text, das_asset_id FROM asset_representations WHERE tenant_id = $1 AND id = $2`, [rep]))[0]!;
    const cases = (recon: string) => q<{ kind: string; status: string }>(`SELECT kind, status FROM reconciliation_cases WHERE tenant_id = $1 AND reconciliation_id = $2`, [recon]);
    const intent = async (recon: string) => (await q<{ status: string }>(`SELECT status FROM issuance_intents WHERE tenant_id = $1 AND reconciliation_id = $2`, [recon]))[0]?.status;
    return { custody, register, leaf, cases, intent, q };
  }

  const deps = (rails: Rails): EngineDeps => ({ pool, rails, policy: { screeningMaxAgeDays: 30, blockedJurisdictions: [] }, mainnetEnabled: false, now: () => new Date(), log });
  /** The chain's rails with the observer and/or DAS wrapped. */
  const faulty = (chain: FakeChain, o: { observer?: ChainObservationPort; assets?: CompressedAssetPort }): Rails => ({
    solana: { ...chain.rails.solana, observer: o.observer ?? chain.rails.solana.observer, compressed: { ...chain.rails.solana.compressed, assets: o.assets ?? chain.rails.solana.compressed.assets } },
  });
  async function tickUntil(rails: Rails, done: () => Promise<boolean>, max = 30) {
    for (let i = 0; i < max && !(await done()); i++) await runTick(deps(rails));
    expect(await done()).toBe(true);
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    unlock = await takeEngineTestLock(pool);
    await migrateUp(pool);
    const sfx = randomUUID().slice(0, 8);
    user = (await sys<{ id: string }>(`INSERT INTO users (oidc_issuer, oidc_subject) VALUES ('test', $1) RETURNING id`, [`faults-u-${sfx}`]))[0]!.id;
    approver = (await sys<{ id: string }>(`INSERT INTO users (oidc_issuer, oidc_subject) VALUES ('test', $1) RETURNING id`, [`faults-a-${sfx}`]))[0]!.id;
  }, ENGINE_TEST_LOCK_WAIT_MS);

  afterAll(async () => {
    await unlock?.();
    await pool?.end();
  });

  it("F1: a mint that lands but is observed as expired keeps its leaf, is never minted again, and opens a case", async () => {
    const chain = fakeChain(); // honest: every transaction lands and is observed final
    const w = await workspace();
    const r = await w.register("Fault F1");
    const observer = withExpiredObservations(chain.rails.solana.observer, firstTransactions(1, (tx) => tx.startsWith("mint-")));
    const rails = faulty(chain, { observer });
    await tickUntil(rails, async () => (await w.intent(r.recon)) === "failed");
    for (let i = 0; i < 3; i++) await runTick(deps(rails));

    expect(observer.misreported.size).toBe(1);
    const l = await w.leaf(r.rep);
    expect(l).toMatchObject({ status: "issuing", leaf_index: "0" });
    expect(chain.onChain.get(l.merkle_tree!)!.numMinted).toBe(1n); // landed once, never again
    expect(chain.mints.filter((m) => m.owner === w.custody)).toHaveLength(1);
    expect(await w.cases(r.recon)).toEqual([{ kind: "orphan_chain_tx", status: "open" }]);

    // The next registration takes the next position.
    const next = await w.register("Fault F1 next");
    await tickUntil(rails, async () => (await w.intent(next.recon)) === "completed");
    expect(await w.leaf(next.rep)).toMatchObject({ merkle_tree: l.merkle_tree, leaf_index: "1" });
  });

  it("F2b: a DAS proof with the wrong leaf never activates the leaf and opens asset_mismatch", async () => {
    const chain = fakeChain();
    const w = await workspace();
    const bad = await w.register("Fault F2b");
    const good = await w.register("Fault F2b control");
    let target = "";
    const assets = withWrongProofs(chain.rails.solana.compressed.assets, (id) => id === target);
    const rails = faulty(chain, { assets });
    await tickUntil(rails, async () => (await w.intent(bad.recon)) === "completed" && (await w.intent(good.recon)) === "completed");
    for (const r of [bad, good]) {
      const l = await w.leaf(r.rep);
      chain.indexed.set(l.das_asset_id!, { id: l.das_asset_id!, owner: w.custody, tree: l.merkle_tree!, leafIndex: Number(l.leaf_index), compressed: true, burnt: false, frozen: false });
    }
    target = (await w.leaf(bad.rep)).das_asset_id!;
    await tickUntil(rails, async () => (await w.leaf(good.rep)).status === "active");
    for (let i = 0; i < 3; i++) await runTick(deps(rails));

    expect(assets.corrupted.has(target)).toBe(true);
    expect((await w.leaf(bad.rep)).status).toBe("issuing");
    expect(await w.cases(bad.recon)).toEqual([{ kind: "asset_mismatch", status: "open" }]);
    expect(await w.cases(good.recon)).toEqual([]);
  });
});
