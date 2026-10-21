/**
 * Compressed NFTs in the execution engine, against a real database with scripted chains: trees are
 * created before leaves, one leaf is minted per tree at a time, failed or expired work is undone
 * the right way, and leaves become active only once DAS shows exactly the leaf that was minted.
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
  type TenantTx,
} from "@metafarm/db";
import { rwaReconciliationSweepHandler } from "../handlers/rwa";
import { ENGINE_TEST_LOCK_WAIT_MS, takeEngineTestLock } from "../test/engine-lock";
import { b58, fakeChain } from "../test/fake-solana";
import { runTick, type EngineDeps } from "./engine";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const log = { info: () => undefined, warn: () => undefined };

d("compressed NFTs in the execution engine", () => {
  let pool: Pool;
  let creator: string;
  let approver: string;

  const sys = <T = Record<string, unknown>>(sql: string, params: unknown[]) =>
    withSystem(pool, async (tx) => (await tx.query(sql, params)).rows as T[]);

  /** A workspace with a farm and a custodian (KYC and screenings clear unless `compliant: false`). */
  async function workspace(o: { compliant?: boolean } = {}) {
    const sfx = randomUUID().slice(0, 8);
    const tenant = (
      await sys<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1, $1) RETURNING id`, [
        `cnft-eng-${sfx}`,
      ])
    )[0]!.id;
    const farm = (
      await sys<{ id: string }>(`INSERT INTO farms (tenant_id, name) VALUES ($1, 'Grove') RETURNING id`, [
        tenant,
      ])
    )[0]!.id;
    const custody = b58();
    const party = await withTenant(pool, tenant, async (tx) => {
      const p = await createParty(tx, {
        kind: "organisation",
        displayName: "Custodian",
        jurisdiction: "AE",
        createdBy: creator,
      });
      if (o.compliant !== false)
        await setKyc(tx, p, {
          status: "verified",
          reference: "kyc-c",
          expiresAt: new Date(Date.now() + 86_400_000 * 365),
          verifiedBy: creator,
        });
      const w = await addWallet(tx, p, "solana-devnet", custody);
      await recordScreening(
        tx,
        { subject: "party", partyId: p },
        {
          provider: "p",
          providerReference: "s1",
          outcome: "clear",
          reasons: [],
          checkedAt: new Date(),
          recordedBy: creator,
        },
      );
      await recordScreening(
        tx,
        { subject: "wallet", walletId: w },
        {
          provider: "p",
          providerReference: "s2",
          outcome: "clear",
          reasons: [],
          checkedAt: new Date(),
          recordedBy: creator,
        },
      );
      return p;
    });
    const inW = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(pool, tenant, fn);
    const q = <T = Record<string, unknown>>(sql: string, params: unknown[]) =>
      inW(async (tx) => (await tx.query(sql, [tx.tenantId, ...params])).rows as T[]);
    /** An approved registration of a new tree asset. */
    const register = (name: string) =>
      inW(async (tx) => {
        const asset = (
          await tx.query<{ id: string }>(
            `INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'tree', $3) RETURNING id`,
            [tx.tenantId, farm, name],
          )
        ).rows[0]!.id;
        const rep = await createCompressedRepresentation(tx, {
          assetId: asset,
          network: "solana-devnet",
          metadata: {
            name,
            symbol: "TREE",
            uri: `https://api.example.com/v1/public/rwa/cnft/${asset}`,
            commitment: { algorithm: "sha256", scheme: "metafarm-rwa-asset/1", hash: "0".repeat(64) },
            commitmentSalt: "00".repeat(16),
          },
        });
        const order = await createRegistrationOrder(tx, {
          partyId: party,
          representationId: rep,
          custodianSolanaAddress: custody,
          createdBy: creator,
        });
        await tx.query(
          `UPDATE rwa_orders SET status = 'issuing', approved_by = $3, approved_at = now() WHERE tenant_id = $1 AND id = $2`,
          [tx.tenantId, order.id, approver],
        );
        return { rep, order: order.id, recon: order.reconciliationId };
      });
    /** This workspace's trees, oldest first. */
    const trees = () =>
      q<{ id: string; status: string; address: string | null; minted_count: string }>(
        `SELECT id, status, address, minted_count::text FROM merkle_trees WHERE tenant_id = $1 ORDER BY created_at`,
        [],
      );
    const leaf = (rep: string) =>
      q<{ status: string; tree_id: string | null; merkle_tree: string | null; leaf_index: string | null; das_asset_id: string | null; leaf_hash: string | null }>(
        `SELECT status, tree_id, merkle_tree, leaf_index::text, das_asset_id, leaf_hash FROM asset_representations WHERE tenant_id = $1 AND id = $2`,
        [rep],
      ).then((r) => r[0]!);
    const orderStatus = (order: string) =>
      q<{ status: string }>(`SELECT status FROM rwa_orders WHERE tenant_id = $1 AND id = $2`, [order]).then((r) => r[0]!.status);
    const mintCompleted = async (recon: string) =>
      (await q(`SELECT 1 FROM issuance_intents WHERE tenant_id = $1 AND reconciliation_id = $2 AND status = 'completed'`, [recon])).length === 1;
    return { tenant, custody, q, register, trees, leaf, orderStatus, mintCompleted };
  }

  const engine = (chain: ReturnType<typeof fakeChain>): EngineDeps => ({
    pool,
    rails: chain.rails,
    policy: { screeningMaxAgeDays: 30, blockedJurisdictions: [] },
    mainnetEnabled: false,
    now: () => new Date(),
    log,
  });
  /** Ticks until `done` holds (or gives up), as the worker would every few seconds. */
  async function tickUntil(chain: ReturnType<typeof fakeChain>, done: () => Promise<boolean>, max = 25) {
    for (let i = 0; i < max; i++) {
      if (await done()) return;
      await runTick(engine(chain));
    }
    expect(await done()).toBe(true);
  }

  let unlock: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    unlock = await takeEngineTestLock(pool);
    await migrateUp(pool);
    const sfx = randomUUID().slice(0, 8);
    creator = (
      await sys<{ id: string }>(
        `INSERT INTO users (oidc_issuer, oidc_subject) VALUES ('test', $1) RETURNING id`,
        [`cnft-eng-c-${sfx}`],
      )
    )[0]!.id;
    approver = (
      await sys<{ id: string }>(
        `INSERT INTO users (oidc_issuer, oidc_subject) VALUES ('test', $1) RETURNING id`,
        [`cnft-eng-a-${sfx}`],
      )
    )[0]!.id;
  }, ENGINE_TEST_LOCK_WAIT_MS);

  afterAll(async () => {
    await unlock?.();
    await pool?.end();
  });

  it("creates a tree, mints the leaf into it, confirms it through DAS and completes the registration", async () => {
    const chain = fakeChain();
    const w = await workspace();
    const r = await w.register("Pistachio A-17");
    const tree = async () =>
      (
        await w.q<{ status: string; address: string | null; minted_count: string }>(
          `SELECT status, address, minted_count::text FROM merkle_trees WHERE tenant_id = $1`,
          [],
        )
      )[0];
    const rep = async () =>
      (
        await w.q<{
          status: string;
          tree_id: string | null;
          merkle_tree: string | null;
          leaf_index: string | null;
          das_asset_id: string | null;
          leaf_hash: string | null;
        }>(
          `SELECT status, tree_id, merkle_tree, leaf_index::text, das_asset_id, leaf_hash FROM asset_representations WHERE tenant_id = $1 AND id = $2`,
          [r.rep],
        )
      )[0]!;

    await tickUntil(chain, async () => (await tree())?.status === "active");
    expect(await w.trees()).toHaveLength(1);
    expect(chain.trees).toContain((await tree())!.address);
    const treeAddress = (await tree())!.address!;
    // The tree's creation passed the network gate only, recorded like any operation.
    const treeOps = await w.q<{ state: string }>(
      `SELECT state FROM chain_operations WHERE tenant_id = $1 AND intent_type = 'tree'`,
      [],
    );
    expect(treeOps.map((o) => o.state)).toEqual(["business_completed"]);

    await tickUntil(
      chain,
      async () =>
        (
          await w.q(
            `SELECT 1 FROM issuance_intents WHERE tenant_id = $1 AND reconciliation_id = $2 AND status = 'completed'`,
            [r.recon],
          )
        ).length === 1,
    );
    const mints = chain.mints.filter((m) => m.owner === w.custody);
    expect(mints).toHaveLength(1);
    expect(mints[0]).toMatchObject({
      merkleTree: treeAddress,
      owner: w.custody,
      metadata: { name: "Pistachio A-17", symbol: "TREE" },
    });
    const minted = await rep();
    expect(minted).toMatchObject({ status: "issuing", merkle_tree: treeAddress, leaf_index: "0" });
    expect(minted.das_asset_id).not.toBeNull();
    expect(minted.leaf_hash).not.toBeNull();
    expect((await tree())!.minted_count).toBe("1");

    // Not active until the indexer shows exactly that leaf.
    await runTick(engine(chain));
    expect((await rep()).status).toBe("issuing");
    chain.indexed.set(minted.das_asset_id!, {
      id: minted.das_asset_id!,
      owner: w.custody,
      tree: treeAddress,
      leafIndex: 0,
      compressed: true,
      burnt: false,
      frozen: false,
    });
    await tickUntil(chain, async () => (await rep()).status === "active");

    await rwaReconciliationSweepHandler(pool, 60)(
      { data: { bucket: "t" } } as never,
      { log: { info: () => undefined } } as never,
    );
    expect(
      (
        await w.q<{ status: string }>(`SELECT status FROM rwa_orders WHERE tenant_id = $1 AND id = $2`, [
          r.order,
        ])
      )[0]!.status,
    ).toBe("completed");
  });

  it("mints one leaf per tree at a time, each at the next index", async () => {
    const chain = fakeChain();
    const w = await workspace();
    chain.leaveSentTransactions("final");
    const a = await w.register("Olive 1");
    const b = await w.register("Olive 2");
    const live = async () =>
      (
        await w.q(
          `SELECT 1 FROM issuance_intents WHERE tenant_id = $1 AND tree_id IS NOT NULL AND status IN ('requested', 'approved', 'in_progress')`,
          [],
        )
      ).length;
    const done = async () =>
      (await w.q(`SELECT 1 FROM issuance_intents WHERE tenant_id = $1 AND status = 'completed'`, []))
        .length === 2;
    for (let i = 0; i < 30 && !(await done()); i++) {
      expect(await live()).toBeLessThan(2);
      await runTick(engine(chain));
    }
    expect(await done()).toBe(true);
    const leaves = await w.q<{ id: string; leaf_index: string; merkle_tree: string }>(
      `SELECT id, leaf_index::text, merkle_tree FROM asset_representations WHERE tenant_id = $1 AND id IN ($2, $3) ORDER BY leaf_index`,
      [a.rep, b.rep],
    );
    expect(leaves.map((l) => l.leaf_index)).toEqual(["0", "1"]);
    expect(new Set(leaves.map((l) => l.merkle_tree)).size).toBe(1);
    expect(await w.trees()).toHaveLength(1);
  });

  it("fails a tree whose creation expired and plans a new one with a new address", async () => {
    const chain = fakeChain();
    const w = await workspace();
    await w.register("Walnut 3");
    chain.leaveSentTransactions("expired");
    await tickUntil(
      chain,
      async () =>
        (await w.q(`SELECT 1 FROM merkle_trees WHERE tenant_id = $1 AND status = 'failed'`, [])).length === 1,
    );
    chain.leaveSentTransactions("final");
    await tickUntil(
      chain,
      async () =>
        (await w.q(`SELECT 1 FROM merkle_trees WHERE tenant_id = $1 AND status = 'active'`, [])).length === 1,
    );
    const trees = await w.q<{ status: string; address: string }>(
      `SELECT status, address FROM merkle_trees WHERE tenant_id = $1 ORDER BY created_at`,
      [],
    );
    expect(trees.map((t) => t.status)).toEqual(["failed", "active"]);
    expect(trees[0]!.address).not.toBe(trees[1]!.address);
  });

  it("gives back the leaf position of a mint that failed, and stops the registration for a person", async () => {
    const chain = fakeChain();
    const w = await workspace();
    const r = await w.register("Fig 4");
    await tickUntil(
      chain,
      async () =>
        (await w.q(`SELECT 1 FROM merkle_trees WHERE tenant_id = $1 AND status = 'active'`, [])).length === 1,
    );
    chain.leaveSentTransactions("failed");
    await tickUntil(
      chain,
      async () =>
        (
          await w.q<{ status: string }>(`SELECT status FROM rwa_orders WHERE tenant_id = $1 AND id = $2`, [
            r.order,
          ])
        )[0]!.status === "exception",
    );
    const rep = (
      await w.q<{
        status: string;
        leaf_index: string | null;
        das_asset_id: string | null;
        tree_id: string | null;
      }>(
        `SELECT status, leaf_index::text, das_asset_id, tree_id FROM asset_representations WHERE tenant_id = $1 AND id = $2`,
        [r.rep],
      )
    )[0]!;
    expect(rep).toMatchObject({ status: "planned", leaf_index: null, das_asset_id: null });
    expect(rep.tree_id).not.toBeNull();
    // The tree is free for the next registration.
    chain.leaveSentTransactions("final");
    const next = await w.register("Fig 5");
    await tickUntil(
      chain,
      async () =>
        (
          await w.q(
            `SELECT 1 FROM issuance_intents WHERE tenant_id = $1 AND reconciliation_id = $2 AND status = 'completed'`,
            [next.recon],
          )
        ).length === 1,
    );
    expect(
      (
        await w.q<{ leaf_index: string }>(
          `SELECT leaf_index::text FROM asset_representations WHERE tenant_id = $1 AND id = $2`,
          [next.rep],
        )
      )[0]!.leaf_index,
    ).toBe("0");
  });

  it("opens a case when DAS shows a different leaf, and leaves it issuing", async () => {
    const chain = fakeChain();
    const w = await workspace();
    const r = await w.register("Almond 6");
    await tickUntil(
      chain,
      async () =>
        (
          await w.q(
            `SELECT 1 FROM issuance_intents WHERE tenant_id = $1 AND reconciliation_id = $2 AND status = 'completed'`,
            [r.recon],
          )
        ).length === 1,
    );
    const assetId = (
      await w.q<{ das_asset_id: string }>(
        `SELECT das_asset_id FROM asset_representations WHERE tenant_id = $1 AND id = $2`,
        [r.rep],
      )
    )[0]!.das_asset_id;
    chain.indexed.set(assetId, {
      id: assetId,
      owner: b58(),
      tree: (await w.trees())[0]!.address!,
      leafIndex: 0,
      compressed: true,
      burnt: false,
      frozen: false,
    });
    await runTick(engine(chain));
    await runTick(engine(chain));
    const cases = await w.q<{ kind: string; status: string }>(
      `SELECT kind, status FROM reconciliation_cases WHERE tenant_id = $1 AND reconciliation_id = $2`,
      [r.recon],
    );
    expect(cases).toEqual([{ kind: "asset_mismatch", status: "open" }]);
    expect(
      (
        await w.q<{ status: string }>(
          `SELECT status FROM asset_representations WHERE tenant_id = $1 AND id = $2`,
          [r.rep],
        )
      )[0]!.status,
    ).toBe("issuing");
  });

  it("creates the tree for a custodian that fails compliance, but refuses to mint to it", async () => {
    const chain = fakeChain();
    const w = await workspace({ compliant: false });
    const r = await w.register("Date palm 7");
    await tickUntil(
      chain,
      async () =>
        (
          await w.q<{ status: string }>(`SELECT status FROM rwa_orders WHERE tenant_id = $1 AND id = $2`, [
            r.order,
          ])
        )[0]!.status === "exception",
    );
    expect(await w.trees()).toHaveLength(1);
    expect(chain.mints.filter((m) => m.owner === w.custody)).toHaveLength(0);
    const ops = await w.q<{ intent_type: string; state: string; error: string | null }>(
      `SELECT intent_type, state, error FROM chain_operations WHERE tenant_id = $1 ORDER BY created_at`,
      [],
    );
    expect(ops.map((o) => [o.intent_type, o.state])).toEqual([
      ["tree", "business_completed"],
      ["issuance", "policy_rejected"],
    ]);
    expect(ops[1]!.error).toContain("kyc_not_verified");
  });
  // ── A transaction that landed although it was not observed to ──────────

  it("activates a tree whose creation landed although it was observed as expired, instead of replacing it", async () => {
    const chain = fakeChain();
    const w = await workspace();
    const r = await w.register("Pecan 8");
    chain.leaveSentTransactions("expired", { lands: true });
    await tickUntil(chain, async () => (await w.trees())[0]?.status === "active");
    const trees = await w.trees();
    expect(trees.map((t) => t.status)).toEqual(["active"]);
    expect(chain.onChain.has(trees[0]!.address!)).toBe(true);
    const ops = await w.q<{ state: string; error: string | null }>(
      `SELECT state, error FROM chain_operations WHERE tenant_id = $1 AND intent_type = 'tree'`,
      [],
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.state).toBe("expired");
    expect(ops[0]!.error).toContain("exists on chain");
    // And the leaf goes into that tree.
    chain.leaveSentTransactions("final");
    await tickUntil(chain, () => w.mintCompleted(r.recon));
    expect(await w.leaf(r.rep)).toMatchObject({ merkle_tree: trees[0]!.address, leaf_index: "0" });
  });

  it("keeps a tree in creation while the chain cannot say whether it was created", async () => {
    const chain = fakeChain();
    const w = await workspace();
    await w.register("Pecan 9");
    chain.leaveSentTransactions("expired");
    chain.knobs.rpcDown = true;
    for (let i = 0; i < 6; i++) await runTick(engine(chain));
    expect((await w.trees()).map((t) => t.status)).toEqual(["creating"]);
    // Readable again, but its blockhash is not yet past finalized height: it could still land.
    chain.knobs.rpcDown = false;
    chain.knobs.finalizedHeight = 900n;
    for (let i = 0; i < 3; i++) await runTick(engine(chain));
    expect((await w.trees()).map((t) => t.status)).toEqual(["creating"]);
    // Definitive: past its validity and absent. Only now is it given up and replaced.
    chain.knobs.finalizedHeight = 2_000n;
    chain.leaveSentTransactions("final");
    await tickUntil(chain, async () => (await w.trees()).map((t) => t.status).join() === "failed,active");
  });

  for (const observed of ["expired", "failed"] as const) {
    it(`never mints again or reuses the position when a mint landed although it was observed as ${observed}`, async () => {
      const chain = fakeChain();
      const w = await workspace();
      const r = await w.register(`Cherry ${observed}`);
      await tickUntil(chain, async () => (await w.trees())[0]?.status === "active");
      const treeAddress = (await w.trees())[0]!.address!;
      chain.leaveSentTransactions(observed, { lands: true });
      await tickUntil(chain, async () => (await w.orderStatus(r.order)) === "exception");
      for (let i = 0; i < 3; i++) await runTick(engine(chain));

      // Exactly one mint was signed and it is on chain; the engine did not sign another.
      expect(chain.mints.filter((m) => m.owner === w.custody)).toHaveLength(1);
      expect(chain.onChain.get(treeAddress)!.numMinted).toBe(1n);
      // The position stays with this asset, and the tree counts the leaf.
      expect(await w.leaf(r.rep)).toMatchObject({ status: "issuing", merkle_tree: treeAddress, leaf_index: "0" });
      expect((await w.trees())[0]!.minted_count).toBe("1");
      const cases = await w.q<{ kind: string; status: string; expected: Record<string, unknown>; observed: Record<string, unknown> }>(
        `SELECT kind, status, expected, observed FROM reconciliation_cases WHERE tenant_id = $1 AND reconciliation_id = $2`,
        [r.recon],
      );
      expect(cases.map((c) => [c.kind, c.status])).toEqual([["orphan_chain_tx", "open"]]);
      expect(cases[0]!.expected).toMatchObject({ tree: treeAddress, leafIndex: "0" });
      expect(cases[0]!.observed).toMatchObject({ treeNumMinted: "1" });
      const ops = await w.q<{ state: string; error: string | null }>(
        `SELECT o.state, o.error FROM chain_operations o JOIN issuance_intents i ON i.tenant_id = o.tenant_id AND i.id = o.intent_id
          WHERE o.tenant_id = $1 AND i.reconciliation_id = $2`,
        [r.recon],
      );
      expect(ops.map((o) => o.state)).toEqual([observed]);
      expect(ops[0]!.error).toContain("in use on chain");

      // The next registration gets the next position, not the one already used.
      chain.leaveSentTransactions("final");
      const next = await w.register(`Cherry ${observed} 2`);
      await tickUntil(chain, () => w.mintCompleted(next.recon));
      expect(await w.leaf(next.rep)).toMatchObject({ merkle_tree: treeAddress, leaf_index: "1" });
      expect(chain.onChain.get(treeAddress)!.numMinted).toBe(2n);
    });
  }

  it("holds a mint's position while the chain cannot say whether it landed, then tries again", async () => {
    const chain = fakeChain();
    const w = await workspace();
    const r = await w.register("Apricot 10");
    await tickUntil(chain, async () => (await w.trees())[0]?.status === "active");
    const treeAddress = (await w.trees())[0]!.address!;
    chain.leaveSentTransactions("expired");
    chain.knobs.rpcDown = true;
    const attempts = () =>
      w.q<{ attempt: number; state: string }>(
        `SELECT o.attempt, o.state FROM chain_operations o JOIN issuance_intents i ON i.tenant_id = o.tenant_id AND i.id = o.intent_id
          WHERE o.tenant_id = $1 AND i.reconciliation_id = $2 ORDER BY o.attempt`,
        [r.recon],
      );
    await tickUntil(chain, async () => (await attempts()).some((a) => a.state === "expired"));
    for (let i = 0; i < 4; i++) await runTick(engine(chain));
    expect((await attempts()).map((a) => [a.attempt, a.state])).toEqual([[1, "expired"]]);
    expect(await w.leaf(r.rep)).toMatchObject({ status: "issuing", leaf_index: "0" });
    expect(await w.orderStatus(r.order)).toBe("issuing");
    // Still within its validity at finalized height: still held.
    chain.knobs.rpcDown = false;
    chain.knobs.finalizedHeight = 900n;
    for (let i = 0; i < 3; i++) await runTick(engine(chain));
    expect((await attempts()).map((a) => a.attempt)).toEqual([1]);
    // Definitively not landed: a second attempt, at the same position, which lands.
    chain.knobs.finalizedHeight = 2_000n;
    chain.leaveSentTransactions("final");
    await tickUntil(chain, () => w.mintCompleted(r.recon));
    expect((await attempts()).map((a) => [a.attempt, a.state])).toEqual([
      [1, "expired"],
      [2, "business_completed"],
    ]);
    expect(await w.leaf(r.rep)).toMatchObject({ leaf_index: "0" });
    expect(chain.onChain.get(treeAddress)!.numMinted).toBe(1n);
    expect(
      (await w.q(`SELECT 1 FROM reconciliation_cases WHERE tenant_id = $1 AND reconciliation_id = $2`, [r.recon])).length,
    ).toBe(0);
  });

  // ── Activation checks the leaf itself, through a verified proof ────────

  it("opens a case when the proof carries a different leaf hash, and waits out a stale proof", async () => {
    const chain = fakeChain();
    const w = await workspace();
    const stale = await w.register("Hazel 11");
    await tickUntil(chain, () => w.mintCompleted(stale.recon));
    const indexAs = async (rep: string) => {
      const l = await w.leaf(rep);
      chain.indexed.set(l.das_asset_id!, {
        id: l.das_asset_id!,
        owner: w.custody,
        tree: l.merkle_tree!,
        leafIndex: Number(l.leaf_index),
        compressed: true,
        burnt: false,
        frozen: false,
      });
    };
    await indexAs(stale.rep);
    // The indexer is behind the chain: no usable proof yet. Nothing is decided.
    chain.knobs.staleProof = true;
    for (let i = 0; i < 3; i++) await runTick(engine(chain));
    expect((await w.leaf(stale.rep)).status).toBe("issuing");
    expect((await w.q(`SELECT 1 FROM reconciliation_cases WHERE tenant_id = $1`, [])).length).toBe(0);
    chain.knobs.staleProof = false;
    await tickUntil(chain, async () => (await w.leaf(stale.rep)).status === "active");

    // Same asset id, tree, index and owner, but the proven leaf is not the one that was minted.
    const forged = await w.register("Hazel 12");
    await tickUntil(chain, () => w.mintCompleted(forged.recon));
    await indexAs(forged.rep);
    chain.knobs.proofLeaf = b58(44);
    for (let i = 0; i < 2; i++) await runTick(engine(chain));
    const cases = await w.q<{ kind: string; expected: Record<string, unknown>; observed: Record<string, unknown> }>(
      `SELECT kind, expected, observed FROM reconciliation_cases WHERE tenant_id = $1 AND reconciliation_id = $2`,
      [forged.recon],
    );
    expect(cases.map((c) => c.kind)).toEqual(["asset_mismatch"]);
    expect(cases[0]!.expected.leafHash).toBe((await w.leaf(forged.rep)).leaf_hash);
    expect(cases[0]!.observed.leafHash).toBe(chain.knobs.proofLeaf);
    expect((await w.leaf(forged.rep)).status).toBe("issuing");
  });

  // ── Off unless configured ───────────────────────────────────────────────

  it("leaves registrations untouched when compressed NFTs are not configured", async () => {
    const chain = fakeChain();
    const w = await workspace();
    const r = await w.register("Quince 13");
    const { compressed: _off, ...solana } = chain.rails.solana;
    const without: EngineDeps = { ...engine(chain), rails: { solana } };
    for (let i = 0; i < 5; i++) await runTick(without);
    expect(await w.trees()).toHaveLength(0);
    expect((await w.q(`SELECT 1 FROM issuance_intents WHERE tenant_id = $1`, [])).length).toBe(0);
    expect(await w.orderStatus(r.order)).toBe("issuing");
    expect(await w.leaf(r.rep)).toMatchObject({ status: "planned", tree_id: null });
    // No Solana rail at all: the same.
    for (let i = 0; i < 2; i++) await runTick({ ...engine(chain), rails: {} });
    expect(await w.trees()).toHaveLength(0);
  });
});
