/** Assets and share tokens: verification by a second person, and linking a mint checked on chain. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ClusterVerificationError, TOKEN_2022_PROGRAM, base58Encode, type SolanaRpc } from "@metafarm/chain";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const ISSUER = base58Encode(new Uint8Array(32).fill(5));
const OTHER = base58Encode(new Uint8Array(32).fill(6));
const MINT = base58Encode(new Uint8Array(32).fill(7));
const FOREIGN_MINT = base58Encode(new Uint8Array(32).fill(8));
const MINT_2 = base58Encode(new Uint8Array(32).fill(4));

function mintData(authority: string, decimals: number) {
  const data = new Uint8Array(82);
  const v = new DataView(data.buffer);
  v.setUint32(0, 1, true);
  const bytes = Uint8Array.from(Buffer.from(authority === ISSUER ? new Uint8Array(32).fill(5) : new Uint8Array(32).fill(6)));
  data.set(bytes, 4);
  data[44] = decimals;
  data[45] = 1;
  return data;
}

d("RWA assets API", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `ra-owner-${sfx}`, admin: `ra-admin-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let farmId: string;
  // What the RPC's cluster check says; "mismatch" = another cluster, "unavailable" = no answer.
  let cluster: "ok" | "mismatch" | "unavailable" = "ok";
  const clusterChecks: string[] = [];
  const reads: string[] = [];
  // A made-up credential that must never reach a response.
  const CRED = "cred-not-real-5678";
  const solanaCluster = async () => {
    clusterChecks.push(cluster);
    if (cluster !== "ok") throw new ClusterVerificationError(cluster, "https://rpc.invalid/[redacted]", `RPC endpoint https://rpc.invalid/${CRED} said ${cluster}`);
  };
  const rpc = {
    getAccountInfo: async (address: string) => {
      reads.push(address);
      if (address === MINT || address === MINT_2) return { owner: TOKEN_2022_PROGRAM, data: mintData(ISSUER, 6) };
      return address === FOREIGN_MINT ? { owner: TOKEN_2022_PROGRAM, data: mintData(OTHER, 6) } : null;
    },
  } as unknown as SolanaRpc;
  const call = async (who: keyof typeof subjects, method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: `/v1/tenants/${tenantId}/rwa${path}`, headers: { authorization: `Bearer ${await tokenFor(subjects[who])}` }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `ra-${sfx}`, name: "Assets", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [tenantId, ids.admin]);
    ({ app } = await buildTestApp({ pool, env: { RWA_SOLANA_ISSUER: ISSUER }, deps: { solanaRpc: rpc, solanaCluster } }));
    farmId = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: { authorization: `Bearer ${await tokenFor(subjects.owner)}` }, payload: { name: "Grove" } })).json().id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("needs a second person to verify, and geometry for trees", async () => {
    const tree = await call("owner", "POST", "/assets", { farmId, kind: "tree", name: "Pistachio A-17" });
    expect(tree.statusCode).toBe(201);
    expect((await call("admin", "POST", `/assets/${tree.json().id}/verify`)).json()).toMatchObject({ error: "geometry_required" });
    const placed = await call("owner", "POST", "/assets", {
      farmId,
      kind: "tree",
      name: "Pistachio A-18",
      geometry: { type: "Point", coordinates: [56.01, 30.4] },
      geomProvenance: "gnss",
    });
    expect(placed.json().geometry).toEqual({ type: "Point", coordinates: [56.01, 30.4] });
    expect((await call("owner", "POST", `/assets/${placed.json().id}/verify`)).json()).toMatchObject({ error: "four_eyes" });
    expect((await call("admin", "POST", `/assets/${placed.json().id}/verify`)).json()).toMatchObject({ status: "verified" });
    expect((await call("owner", "POST", "/assets", { farmId, kind: "tree", name: "x", geometry: { type: "Point", coordinates: [1, 2] } })).statusCode).toBe(400);
  });

  it("issues share tokens only for verified assets and links only the issuer's mints", async () => {
    const shares = (await call("owner", "POST", "/assets", { farmId, kind: "farm_share", name: "Grove shares" })).json();
    expect((await call("owner", "POST", `/assets/${shares.id}/representations`, { network: "solana-devnet", decimals: 6 })).json()).toMatchObject({ error: "asset_not_verified" });
    await call("admin", "POST", `/assets/${shares.id}/verify`);
    expect((await call("owner", "POST", `/assets/${shares.id}/representations`, { network: "solana-mainnet", decimals: 6 })).json()).toMatchObject({ error: "network_not_enabled" });
    const planned = await call("owner", "POST", `/assets/${shares.id}/representations`, { network: "solana-devnet", decimals: 6 });
    expect(planned.statusCode).toBe(201);
    const repId = planned.json().representations[0].id as string;
    expect((await call("owner", "POST", `/representations/${repId}/mint`, { mintAddress: OTHER })).json()).toMatchObject({ error: "not_a_mint" });
    expect((await call("owner", "POST", `/representations/${repId}/mint`, { mintAddress: FOREIGN_MINT })).json()).toMatchObject({ error: "not_our_mint" });
    const linked = await call("owner", "POST", `/representations/${repId}/mint`, { mintAddress: MINT });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().representations[0]).toMatchObject({ status: "active", mintAddress: MINT, decimals: 6 });
    expect((await call("owner", "POST", `/representations/${repId}/mint`, { mintAddress: MINT })).json()).toMatchObject({ error: "mint_linked" });
    expect((await call("owner", "GET", "/assets")).json().items.length).toBe(3);
  });
  it("reads a mint only from an RPC proven to serve the configured network", async () => {
    const shares = (await call("owner", "POST", "/assets", { farmId, kind: "farm_share", name: "Cluster check" })).json();
    await call("admin", "POST", `/assets/${shares.id}/verify`);
    const repId = (await call("owner", "POST", `/assets/${shares.id}/representations`, { network: "solana-devnet", decimals: 6 })).json().representations[0].id as string;

    for (const [state, status, error] of [
      ["mismatch", 422, "solana_cluster_mismatch"],
      ["unavailable", 503, "solana_rpc_unavailable"],
    ] as const) {
      cluster = state;
      reads.length = 0;
      const res = await call("owner", "POST", `/representations/${repId}/mint`, { mintAddress: MINT });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ error });
      // Nothing was read from that RPC, nothing was linked, and no endpoint or credential leaked.
      expect(reads).toHaveLength(0);
      expect(res.body).not.toContain(CRED);
      expect(res.body).not.toContain("rpc.invalid");
    }
    const still = (await call("owner", "GET", "/assets")).json().items.find((a: { id: string }) => a.id === shares.id);
    expect(still.representations[0]).toMatchObject({ mintAddress: null });

    // Once the RPC proves its cluster the mint is read and linked.
    cluster = "ok";
    const linked = await call("owner", "POST", `/representations/${repId}/mint`, { mintAddress: MINT_2 });
    expect(linked.statusCode).toBe(200);
    expect(reads).toEqual([MINT_2]);
    expect(clusterChecks.slice(-3)).toEqual(["mismatch", "unavailable", "ok"]);
  });

  it("refuses to link when no cluster check is configured", async () => {
    const { app: unchecked } = await buildTestApp({ pool, env: { RWA_SOLANA_ISSUER: ISSUER }, deps: { solanaRpc: rpc } });
    try {
      const res = await unchecked.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/rwa/representations/00000000-0000-4000-8000-000000000000/mint`,
        headers: { authorization: `Bearer ${await tokenFor(subjects.owner)}` },
        payload: { mintAddress: MINT },
      });
      expect(res.json()).toMatchObject({ error: "issuance_not_configured" });
    } finally {
      await unchecked.close();
    }
  });
});
