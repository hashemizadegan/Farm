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
import type {
  AssetIssuancePort,
  ChainObservation,
  ChainObservationPort,
  CompressedAssetPort,
  CompressedAssetRecord,
  CompressedIssuancePort,
  CompressedMintRequest,
  PreparedTransaction,
} from "@metafarm/domain";
import { rwaReconciliationSweepHandler } from "../handlers/rwa";
import { runTick, type EngineDeps } from "./engine";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const log = { info: () => undefined, warn: () => undefined };
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (n = 40) => Array.from({ length: n }, () => B58[Math.floor(Math.random() * B58.length)]).join("");

/**
 * One scripted Solana devnet: what happens to each transaction, which trees exist with how many
 * leaves, and what DAS has indexed. A mint that lands final advances its tree, as on chain.
 */
function fakeChain() {
  const fate = new Map<string, ChainObservation["status"]>();
  /** What to do with each transaction when it is sent: land it, or leave it to the test. */
  let onSend: ChainObservation["status"] | undefined = "final";
  const minted = new Map<string, bigint>();
  const mintOf = new Map<string, { tree: string }>();
  const trees: string[] = [];
  const mints: CompressedMintRequest[] = [];
  const indexed = new Map<string, CompressedAssetRecord>();
  const prepared = (txRef: string, summary: Record<string, unknown>): PreparedTransaction => ({
    network: "solana-devnet",
    txRef,
    wire: Buffer.from(txRef).toString("base64"),
    validity: { lastValidBlockHeight: 1_000n },
    fees: { priorityFeeMicroLamports: 1n, computeUnitLimit: 1 },
    summary,
  });
  const compressed: CompressedIssuancePort = {
    prepareCreateTree: async (r) => {
      const treeAddress = b58();
      trees.push(treeAddress);
      return {
        ...prepared(`tree-${b58(20)}`, { action: "create_tree", tree: treeAddress }),
        treeAddress,
        capacity: 1n << BigInt(r.maxDepth),
      };
    },
    prepareMint: async (r) => {
      mints.push(r);
      const leafIndex = minted.get(r.merkleTree) ?? 0n;
      const txRef = `mint-${b58(20)}`;
      mintOf.set(txRef, { tree: r.merkleTree });
      return { ...prepared(txRef, { action: "mint_cnft" }), assetId: b58(), leafIndex, leafHash: b58(44) };
    },
  };
  const observer: ChainObservationPort = {
    submit: async (p) => {
      if (!fate.has(p.txRef)) fate.set(p.txRef, onSend ?? "pending");
      const m = mintOf.get(p.txRef);
      if (m && fate.get(p.txRef) === "final") {
        mintOf.delete(p.txRef);
        minted.set(m.tree, (minted.get(m.tree) ?? 0n) + 1n);
      }
    },
    observe: async (t) => ({ status: fate.get(t.txRef) ?? "not_found", slotOrBlock: 99n }),
  };
  const assets: CompressedAssetPort = {
    getAsset: async (_n, id) => indexed.get(id) ?? null,
    getAssetProof: async () => {
      throw new Error("not used");
    },
  };
  const unused: AssetIssuancePort = {
    prepareCreateMint: async () => {
      throw new Error("not used");
    },
    prepareIssuance: async () => {
      throw new Error("not used");
    },
  };
  return {
    rails: {
      solana: {
        network: "solana-devnet" as const,
        issuance: unused,
        observer,
        compressed: {
          issuance: compressed,
          assets,
          creator: b58(),
          treeShape: { maxDepth: 3, maxBufferSize: 8, canopyDepth: 0, capacity: 8 },
        },
      },
    },
    fate,
    trees,
    mints,
    indexed,
    leaveSentTransactions: (status: ChainObservation["status"] | undefined) => (onSend = status),
  };
}

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
    return { tenant, custody, q, register };
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

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
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
  });

  afterAll(async () => {
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
    expect(chain.trees).toHaveLength(1);
    expect((await tree())!.address).toBe(chain.trees[0]);
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
    expect(chain.mints).toHaveLength(1);
    expect(chain.mints[0]).toMatchObject({
      merkleTree: chain.trees[0],
      owner: w.custody,
      metadata: { name: "Pistachio A-17", symbol: "TREE" },
    });
    const minted = await rep();
    expect(minted).toMatchObject({ status: "issuing", merkle_tree: chain.trees[0], leaf_index: "0" });
    expect(minted.das_asset_id).not.toBeNull();
    expect(minted.leaf_hash).not.toBeNull();
    expect((await tree())!.minted_count).toBe("1");

    // Not active until the indexer shows exactly that leaf.
    await runTick(engine(chain));
    expect((await rep()).status).toBe("issuing");
    chain.indexed.set(minted.das_asset_id!, {
      id: minted.das_asset_id!,
      owner: w.custody,
      tree: chain.trees[0]!,
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
    expect(chain.trees).toHaveLength(1);
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
      tree: chain.trees[0]!,
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
    expect(chain.trees).toHaveLength(1);
    expect(chain.mints).toHaveLength(0);
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
});
