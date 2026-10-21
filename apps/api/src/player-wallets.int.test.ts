/**
 * J8 player wallets against a real database: off by default, proof of control by a signed one-time
 * challenge, single use, one user per wallet, unlinking, "held by you" on asset detail, and complete
 * separation from RWA party wallets.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { base58Encode } from "@metafarm/chain";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import type { ChainAssetRef, OwnershipReader } from "@metafarm/domain";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = base58Encode(new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32)));
  return { address, sign: (message: string) => sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64") };
}

d("player wallets (J8)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let off: FastifyInstance;
  let later: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const alice = `pw-alice-${sfx}`;
  const bob = `pw-bob-${sfx}`;
  const mine = wallet();
  const investor = wallet(); // an RWA party wallet, never linked as a player wallet
  let tenantId: string;
  let assetId: string;
  let mint: string;

  // The asset's holders, as an index of the chain would report them.
  const holders = () => [
    { owner: mine.address, amount: 5n },
    { owner: investor.address, amount: 7n },
  ];
  const reader = (source: "chain_index" | "fixture"): OwnershipReader => ({
    source,
    async holdersOf(_a: ChainAssetRef) {
      return { holders: holders(), asOfSlot: 900n, assurance: source === "fixture" ? "fixture" : "indexer_reported" };
    },
  });

  const as = async (who: string) => ({ authorization: `Bearer ${await tokenFor(who)}` });
  const challenge = async (a: FastifyInstance, who: string, address: string) =>
    a.inject({ method: "POST", url: "/v1/me/player-wallets/challenge", headers: await as(who), payload: { address } });
  const link = async (a: FastifyInstance, who: string, address: string, signature: string) =>
    a.inject({ method: "POST", url: "/v1/me/player-wallets", headers: await as(who), payload: { address, signature } });
  const prove = async (who: string, w: ReturnType<typeof wallet>, a = app) => {
    const c = await challenge(a, who, w.address);
    expect(c.statusCode).toBe(200);
    return link(a, who, w.address, w.sign(c.json().message));
  };
  const list = async (who: string) => (await app.inject({ method: "GET", url: "/v1/me/player-wallets", headers: await as(who) })).json().items as { address: string }[];

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    const aliceId = (await upsertUserBySubject(pool, { issuer: "dev", subject: alice })).id;
    await upsertUserBySubject(pool, { issuer: "dev", subject: bob });
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `pw-${sfx}`, name: "Players", ownerUserId: aliceId }));
    const env = { PLAYER_WALLETS_ENABLED: "true" };
    ({ app } = await buildTestApp({ pool, env, deps: { ownershipReader: reader("chain_index") } }));
    ({ app: off } = await buildTestApp({ pool, deps: { ownershipReader: reader("chain_index") } }));
    ({ app: later } = await buildTestApp({ pool, env, deps: { now: () => new Date(Date.now() + 3_600_000) } }));

    const farmId = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: await as(alice), payload: { name: "Grove" } })).json().id;
    assetId = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/rwa/assets`, headers: await as(alice), payload: { farmId, kind: "farm_share", name: "Shares" } })).json().id;
    mint = wallet().address;
    await pool.query(
      `INSERT INTO asset_representations (tenant_id, asset_id, rail, network, status, mint_address, decimals) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'solana-devnet', 'active', $3, 0)`,
      [tenantId, assetId, mint],
    );
  });

  afterAll(async () => {
    for (const a of [app, off, later]) await a?.close();
    await pool?.end();
  });

  it("is off by default: every route answers 404", async () => {
    const h = await as(alice);
    expect((await off.inject({ method: "GET", url: "/v1/me/player-wallets", headers: h })).statusCode).toBe(404);
    expect((await challenge(off, alice, mine.address)).statusCode).toBe(404);
    expect((await link(off, alice, mine.address, "A".repeat(86) + "==")).statusCode).toBe(404);
    expect((await off.inject({ method: "DELETE", url: `/v1/me/player-wallets/${mine.address}`, headers: h })).statusCode).toBe(404);
  });

  it("needs a signed-in user", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/me/player-wallets" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/me/player-wallets/challenge", payload: { address: mine.address } })).statusCode).toBe(401);
  });

  it("links a wallet whose signature of the issued message checks out, once per challenge", async () => {
    const c = await challenge(app, alice, mine.address);
    const { message } = c.json();
    expect(message).toContain(mine.address);
    expect(message).toContain("does not authorise any transaction");
    const signature = mine.sign(message);
    const r = await link(app, alice, mine.address, signature);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ chain: "solana", address: mine.address });
    // The same signature again: the challenge is gone.
    const replay = await link(app, alice, mine.address, signature);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe("player_wallet_challenge_missing");
    // Proving it again changes nothing.
    expect((await prove(alice, mine)).statusCode).toBe(200);
    expect((await list(alice)).map((w) => w.address)).toEqual([mine.address]);
  });

  it("refuses a wrong signature and burns the challenge", async () => {
    const w = wallet();
    const c = (await challenge(app, alice, w.address)).json();
    const bad = await link(app, alice, w.address, wallet().sign(c.message));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("player_wallet_verification_failed");
    expect((await link(app, alice, w.address, w.sign(c.message))).json().error).toBe("player_wallet_challenge_missing");
    expect((await list(alice)).map((x) => x.address)).not.toContain(w.address);
  });

  it("refuses an expired challenge, and malformed input", async () => {
    const w = wallet();
    const c = (await challenge(app, alice, w.address)).json();
    const r = await link(later, alice, w.address, w.sign(c.message));
    expect(r.json().error).toBe("player_wallet_challenge_missing");
    expect((await challenge(app, alice, "0x" + "ab".repeat(20))).statusCode).toBe(400);
    expect((await link(app, alice, w.address, "not-base64")).statusCode).toBe(400);
  });

  it("links a wallet to one account only", async () => {
    const r = await prove(bob, mine);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("player_wallet_already_linked");
    expect(await list(bob)).toEqual([]);
  });

  it("says whether the caller's own player wallets hold an asset, from chain readings only", async () => {
    const get = async (a: FastifyInstance) => (await a.inject({ method: "GET", url: `/v1/tenants/${tenantId}/twin/assets/${assetId}`, headers: await as(alice) })).json().ownership[0];
    const reading = await get(app);
    expect(reading).toMatchObject({ status: "indexed", source: "chain_index", heldByYou: true });
    // Off: never stated.
    expect(await get(off)).not.toHaveProperty("heldByYou");
    // Fixture data: never stated.
    const { app: fixture } = await buildTestApp({ pool, env: { PLAYER_WALLETS_ENABLED: "true" }, deps: { ownershipReader: reader("fixture") } });
    expect(await get(fixture)).not.toHaveProperty("heldByYou");
    await fixture.close();
  });

  it("keeps player wallets and RWA party wallets apart", async () => {
    // The investor's address is registered as an RWA party wallet in this workspace.
    const h = await as(alice);
    const party = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/rwa/parties`, headers: h, payload: { kind: "person", displayName: "Investor" } })).json().id;
    const pw = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/rwa/parties/${party}/wallets`, headers: h, payload: { network: "solana-devnet", address: investor.address } });
    expect(pw.statusCode).toBe(201);
    // ...which makes it neither a player wallet nor "held by you".
    expect((await list(alice)).map((w) => w.address)).toEqual([mine.address]);
    // Linking a player wallet created no party wallet.
    expect((await pool.query(`SELECT 1 FROM party_wallets WHERE address = $1`, [mine.address])).rowCount).toBe(0);
    // With only the investor wallet held, alice holds nothing as a player.
    await app.inject({ method: "DELETE", url: `/v1/me/player-wallets/${mine.address}`, headers: h });
    const { app: onlyInvestor } = await buildTestApp({
      pool,
      env: { PLAYER_WALLETS_ENABLED: "true" },
      deps: { ownershipReader: { source: "chain_index", holdersOf: async () => ({ holders: [{ owner: investor.address, amount: 7n }], asOfSlot: 900n, assurance: "indexer_reported" }) } },
    });
    await prove(alice, mine, onlyInvestor);
    const reading = (await onlyInvestor.inject({ method: "GET", url: `/v1/tenants/${tenantId}/twin/assets/${assetId}`, headers: h })).json().ownership[0];
    expect(reading.heldByYou).toBe(false);
    await onlyInvestor.close();
  });

  it("unlinks only the caller's own wallet", async () => {
    expect((await app.inject({ method: "DELETE", url: `/v1/me/player-wallets/${mine.address}`, headers: await as(bob) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/v1/me/player-wallets/${mine.address}`, headers: await as(alice) })).statusCode).toBe(204);
    expect(await list(alice)).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/v1/me/player-wallets/${mine.address}`, headers: await as(alice) })).statusCode).toBe(404);
  });
});
