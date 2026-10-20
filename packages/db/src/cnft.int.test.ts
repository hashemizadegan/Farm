/** Compressed-NFT trees, leaves and registration orders against a real database (migration 0016). */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orderLegsDone, reconcileOrder } from "@metafarm/domain";
import { createPool, type Pool } from "./pool";
import { migrateUp } from "./migrate";
import { withSystem, withTenant, type TenantTx } from "./tenant";
import {
  activateLeaf,
  activateMerkleTree,
  createCompressedRepresentation,
  createRegistrationOrder,
  currentMerkleTree,
  failMerkleTree,
  getMerkleTree,
  markMerkleTreeCreating,
  planMerkleTree,
  recordLeafMinted,
  recordPlannedLeaf,
} from "./repositories/cnft";
import { getOrder, listOrders, orderForReconciliation } from "./repositories/rwa";
import { createIssuanceIntent, setIntentStatus } from "./repositories/rwa-execution";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

/** The SQLSTATE a promise fails with, or "ok". */
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? "unknown",
  );

d("compressed NFT trees and registrations", () => {
  let pool: Pool;
  let tenantA: string;
  let tenantB: string;
  let user: string;
  let custodian: string;
  const assets: string[] = [];
  const inA = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(pool, tenantA, fn);
  const inB = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(pool, tenantB, fn);
  const SIGNER = "PLATFoRMsigner1111111111111111111111111111";
  const CUSTODY = "CusToDy11111111111111111111111111111111111";
  const smallTree = {
    network: "solana-devnet" as const,
    maxDepth: 3,
    maxBufferSize: 8,
    canopyDepth: 0,
    capacity: 8n,
    creatorAddress: SIGNER,
  };
  const leafMetadata = (asset: string) => ({
    name: `Tree ${asset.slice(0, 8)}`,
    symbol: "TREE",
    uri: `https://api.example.com/v1/public/rwa/cnft/${asset}`,
    commitment: { algorithm: "sha256" as const, scheme: "metafarm-rwa-asset/1", hash: "0".repeat(64) },
    commitmentSalt: "00112233445566778899aabbccddeeff",
  });
  const address = () =>
    `Tree${randomUUID()
      .replace(/[^1-9a-km-zA-HJ-NP-Z]/g, "")
      .padEnd(40, "1")
      .slice(0, 40)}`;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 4 });
    await migrateUp(pool);
    const sfx = randomUUID().slice(0, 8);
    await withSystem(pool, async (tx) => {
      const tenant = async (slug: string) =>
        (
          await tx.query<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1, $1) RETURNING id`, [
            slug,
          ])
        ).rows[0]!.id;
      tenantA = await tenant(`cnft-a-${sfx}`);
      tenantB = await tenant(`cnft-b-${sfx}`);
      user = (
        await tx.query<{ id: string }>(
          `INSERT INTO users (oidc_issuer, oidc_subject) VALUES ('test', $1) RETURNING id`,
          [`cnft-${sfx}`],
        )
      ).rows[0]!.id;
      const farm = (
        await tx.query<{ id: string }>(
          `INSERT INTO farms (tenant_id, name) VALUES ($1, 'Orchard') RETURNING id`,
          [tenantA],
        )
      ).rows[0]!.id;
      for (const name of ["Olive 1", "Olive 2"]) {
        assets.push(
          (
            await tx.query<{ id: string }>(
              `INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'tree', $3) RETURNING id`,
              [tenantA, farm, name],
            )
          ).rows[0]!.id,
        );
      }
      custodian = (
        await tx.query<{ id: string }>(
          `INSERT INTO parties (tenant_id, kind, display_name) VALUES ($1, 'organisation', 'Custodian') RETURNING id`,
          [tenantA],
        )
      ).rows[0]!.id;
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("keeps one current tree per workspace and network, invisible to other workspaces", async () => {
    const id = await inA((tx) => planMerkleTree(tx, { ...smallTree, createdBy: user }));
    expect(await codeOf(inA((tx) => planMerkleTree(tx, { ...smallTree, createdBy: user })))).toBe("23505");
    expect((await inA((tx) => currentMerkleTree(tx, "solana-devnet")))?.id).toBe(id);
    expect(await inB((tx) => currentMerkleTree(tx, "solana-devnet"))).toBeUndefined();
    expect(await inB((tx) => getMerkleTree(tx, id))).toBeUndefined();
    // Another workspace plans its own.
    expect(await codeOf(inB((tx) => planMerkleTree(tx, { ...smallTree, createdBy: null })))).toBe("ok");
  });

  it("creates, activates and fills a tree, then lets the next one be planned", async () => {
    const tree = (await inA((tx) => currentMerkleTree(tx, "solana-devnet")))!;
    const addr = address();
    expect(await inA((tx) => markMerkleTreeCreating(tx, tree.id, addr))).toBe(true);
    expect(await inA((tx) => markMerkleTreeCreating(tx, tree.id, address()))).toBe(false);
    expect(await inA((tx) => activateMerkleTree(tx, tree.id))).toBe(true);
    let last: Awaited<ReturnType<typeof recordLeafMinted>>;
    for (let i = 0; i < 8; i++) last = await inA((tx) => recordLeafMinted(tx, tree.id));
    expect(last!).toEqual({ mintedCount: 8n, status: "full" });
    expect(await inA((tx) => recordLeafMinted(tx, tree.id))).toBeUndefined();
    expect(await inA((tx) => failMerkleTree(tx, tree.id))).toBe(false);
    expect((await inA((tx) => getMerkleTree(tx, tree.id)))?.address).toBe(addr);
    expect(await inA((tx) => currentMerkleTree(tx, "solana-devnet"))).toBeUndefined();
    expect(await codeOf(inA((tx) => planMerkleTree(tx, { ...smallTree, createdBy: user })))).toBe("ok");
  });

  it("registers an asset as one leaf, outside the investor order views, one mint per tree at a time", async () => {
    const tree = (await inA((tx) => currentMerkleTree(tx, "solana-devnet")))!;
    const addr = address();
    await inA(async (tx) => {
      await markMerkleTreeCreating(tx, tree.id, addr);
      await activateMerkleTree(tx, tree.id);
    });
    const register = (asset: string) =>
      inA(async (tx) => {
        const rep = await createCompressedRepresentation(tx, { assetId: asset, network: "solana-devnet", metadata: leafMetadata(asset), treeId: tree.id });
        const order = await createRegistrationOrder(tx, {
          partyId: custodian,
          representationId: rep,
          custodianSolanaAddress: CUSTODY,
          createdBy: user,
        });
        return { rep, order };
      });
    const mint = (r: { rep: string; order: { reconciliationId: string } }) =>
      inA((tx) =>
        createIssuanceIntent(tx, {
          representationId: r.rep,
          action: "mint",
          amount: 1n,
          holder: CUSTODY,
          reconciliationId: r.order.reconciliationId,
          partyId: custodian,
          decision: { reason: "test" },
        }),
      );

    const first = await register(assets[0]!);
    const second = await register(assets[1]!);
    expect((await inA((tx) => listOrders(tx))).map((o) => o.id)).not.toContain(first.order.id);
    expect(await inA((tx) => getOrder(tx, first.order.id))).toBeUndefined();

    const intent = await mint(first);
    const filled = await inA((tx) =>
      tx.query<{ tree_id: string }>(`SELECT tree_id FROM issuance_intents WHERE tenant_id = $1 AND id = $2`, [
        tx.tenantId,
        intent,
      ]),
    );
    expect(filled.rows[0]!.tree_id).toBe(tree.id);
    expect(await codeOf(mint(second))).toBe("23505");

    expect(
      await inA((tx) =>
        recordPlannedLeaf(tx, first.rep, {
          merkleTree: addr,
          leafIndex: 0n,
          assetId: `Asset${randomUUID().slice(0, 8)}`,
        }),
      ),
    ).toBe(true);
    expect(await inA((tx) => activateLeaf(tx, first.rep))).toBe(true);
    expect(
      await inA((tx) =>
        recordPlannedLeaf(tx, first.rep, { merkleTree: addr, leafIndex: 1n, assetId: "moved" }),
      ),
    ).toBe(false);
    await inA(async (tx) => {
      await setIntentStatus(tx, "issuance", intent, "completed");
      await recordLeafMinted(tx, tree.id);
    });

    const view = (await inA((tx) => orderForReconciliation(tx, first.order.id)))!;
    expect(view.order).toMatchObject({ kind: "registration", shareAmount: 1n, settlementAmount: null });
    expect(reconcileOrder(view.order, view.intents, new Date(), 60)).toEqual([]);
    expect(orderLegsDone(view.order, view.intents)).toBe(true);

    // The tree is free again: the next registration's mint may start.
    expect(await codeOf(mint(second))).toBe("ok");
  });
});
