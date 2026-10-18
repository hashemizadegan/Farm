/** RWA API against a real database: permissions, the compliance gate, orders and verified payments. */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { base58Encode, concatBytes, fromHex, toHex, transferCallData, tronAddressBytes, tronAddressFromHex, utf8, TRANSFER_EVENT_TOPIC, type TronHttp } from "@metafarm/chain";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const TOKEN = tronAddressFromHex(`41${"a6".repeat(20)}`);
const TREASURY = tronAddressFromHex(`41${"22".repeat(20)}`);
const INVESTOR_TRON = tronAddressFromHex(`41${"33".repeat(20)}`);
const INVESTOR_SOL = base58Encode(new Uint8Array(32).fill(44));

// A tiny protobuf writer, to serve a real TRON transaction from the fake node.
const varint = (n: bigint) => {
  const out: number[] = [];
  let v = n;
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Uint8Array.from(out);
};
const pbInt = (no: number, v: bigint) => concatBytes(varint(BigInt(no << 3)), varint(v));
const pbBytes = (no: number, b: Uint8Array) => concatBytes(varint(BigInt((no << 3) | 2)), varint(BigInt(b.length)), b);
const word = (a: string) => "0".repeat(24) + toHex(tronAddressBytes(a)).slice(2);

/** A payment of `amount` from the investor to the treasury, as the solidity node reports it. */
function payment(amount: bigint, nonce: number) {
  const trigger = concatBytes(pbBytes(1, tronAddressBytes(INVESTOR_TRON)), pbBytes(2, tronAddressBytes(TOKEN)), pbBytes(4, fromHex(transferCallData(TREASURY, amount))));
  const any = concatBytes(pbBytes(1, utf8("type.googleapis.com/protocol.TriggerSmartContract")), pbBytes(2, trigger));
  const raw = concatBytes(pbInt(8, 1_792_000_000_000n + BigInt(nonce)), pbBytes(11, concatBytes(pbInt(1, 31n), pbBytes(2, any))), pbInt(18, 30_000_000n));
  const id = createHash("sha256").update(raw).digest("hex");
  return {
    id,
    tx: { txID: id, raw_data_hex: toHex(raw), ret: [{ contractRet: "SUCCESS" }] },
    info: {
      id,
      blockNumber: 6_400_000 + nonce,
      blockTimeStamp: 1_792_000_000_000,
      receipt: { result: "SUCCESS" },
      log: [{ address: toHex(tronAddressBytes(TOKEN)).slice(2), topics: [TRANSFER_EVENT_TOPIC, word(INVESTOR_TRON), word(TREASURY)], data: amount.toString(16).padStart(64, "0") }],
    },
  };
}

d("RWA API", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `rw-owner-${sfx}`, manager: `rw-mgr-${sfx}`, worker: `rw-wrk-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let representationId: string;
  let partyId: string;
  const chain = new Map<string, ReturnType<typeof payment>>();
  const tron: TronHttp = {
    async post<T>(path: string, body: Record<string, unknown>) {
      const p = chain.get(body.value as string);
      if (!p) return {} as T;
      return (path.endsWith("gettransactionbyid") ? p.tx : p.info) as T;
    },
  };
  const call = async (who: keyof typeof subjects, method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: `/v1/tenants/${tenantId}/rwa${path}`, headers: { authorization: `Bearer ${await tokenFor(subjects[who])}` }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `rwa-api-${sfx}`, name: "RWA", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'worker')`, [tenantId, ids.manager, ids.worker]);
    ({ app } = await buildTestApp({ pool, env: { RWA_TRON_TREASURY: TREASURY }, deps: { tron } }));
    const farmId = (
      await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: { authorization: `Bearer ${await tokenFor(subjects.owner)}` }, payload: { name: "Grove" } })
    ).json().id;
    representationId = await withSystem(pool, async (tx) => {
      const a = (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'farm_share', 'Grove shares') RETURNING id`, [tenantId, farmId])).rows[0]!.id;
      return (await tx.query<{ id: string }>(`INSERT INTO asset_representations (tenant_id, asset_id, rail, network, decimals, status) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'solana-devnet', 6, 'active') RETURNING id`, [tenantId, a])).rows[0]!.id;
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  const order = (o: object = {}) => ({
    kind: "subscription",
    partyId,
    representationId,
    shareAmount: "1000000",
    settlementNetwork: "tron-nile",
    tokenContract: TOKEN,
    settlementAmount: "50000000",
    tronWallet: INVESTOR_TRON,
    solanaWallet: INVESTOR_SOL,
    ...o,
  });

  it("lets owners register investors; managers read; field workers see nothing", async () => {
    expect((await call("manager", "POST", "/parties", { kind: "person", displayName: "X" })).statusCode).toBe(403);
    const r = await call("owner", "POST", "/parties", { kind: "person", displayName: "First investor", jurisdiction: "ae" });
    expect(r.statusCode).toBe(201);
    partyId = r.json().id;
    expect(r.json()).toMatchObject({ jurisdiction: "AE", kyc: { status: "unverified" }, compliance: { allowed: false } });
    expect((await call("manager", "GET", "/parties")).json().items).toHaveLength(1);
    expect((await call("worker", "GET", "/parties")).statusCode).toBe(403);
  });

  it("refuses orders until KYC and screenings are in place", async () => {
    const blocked = await call("owner", "POST", "/orders", order());
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ error: "compliance_blocked" });
    expect(blocked.json().details).toEqual(["kyc_not_verified", "party_unscreened", "wallet_unscreened"]);

    expect((await call("owner", "POST", `/parties/${partyId}/kyc`, { status: "verified" })).statusCode).toBe(400);
    await call("owner", "POST", `/parties/${partyId}/kyc`, { status: "verified", reference: "kyc-case-1", expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString() });
    expect((await call("owner", "POST", `/parties/${partyId}/wallets`, { network: "tron-nile", address: INVESTOR_SOL })).statusCode).toBe(400);
    await call("owner", "POST", `/parties/${partyId}/wallets`, { network: "tron-nile", address: INVESTOR_TRON });
    const withSol = await call("owner", "POST", `/parties/${partyId}/wallets`, { network: "solana-devnet", address: INVESTOR_SOL });
    const now = new Date().toISOString();
    await call("owner", "POST", `/parties/${partyId}/screenings`, { provider: "provider", providerReference: "s-1", outcome: "clear", checkedAt: now });
    for (const w of withSol.json().wallets as { id: string }[]) {
      await call("owner", "POST", `/parties/${partyId}/screenings`, { walletId: w.id, provider: "provider", providerReference: `w-${w.id}`, outcome: "clear", checkedAt: now });
    }
    const party = (await call("manager", "GET", `/parties/${partyId}`)).json();
    expect(party.compliance).toEqual({ allowed: true, reasons: [] });
    expect(party.screenings).toHaveLength(3);
    expect((await call("owner", "POST", "/orders", order({ settlementNetwork: "tron-mainnet" }))).json()).toMatchObject({ error: "network_not_enabled" });
  });

  it("records a subscription payment only when the chain shows exactly that payment", async () => {
    const placed = await call("owner", "POST", "/orders", order());
    expect(placed.statusCode).toBe(201);
    const id = placed.json().id as string;
    expect(placed.json()).toMatchObject({ status: "open", settlement: [], issuance: [] });

    const short = payment(49_000_000n, 1);
    chain.set(short.id, short);
    const wrong = await call("owner", "POST", `/orders/${id}/payments`, { txId: short.id });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().details).toMatchObject({ reason: "mismatch", detail: "amount" });
    expect((await call("owner", "POST", `/orders/${id}/payments`, { txId: "ab".repeat(32) })).json().details).toMatchObject({ reason: "not_solidified" });

    const good = payment(50_000_000n, 2);
    chain.set(good.id, good);
    const paid = await call("owner", "POST", `/orders/${id}/payments`, { txId: good.id });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ status: "issuing", discrepancies: [] });
    expect(paid.json().settlement).toEqual([
      expect.objectContaining({ purpose: "subscription", direction: "inbound", status: "completed", txId: good.id, observedAmount: "50000000", payer: INVESTOR_TRON, payee: TREASURY }),
    ]);
    // Same payment again: nothing new. For another order: refused.
    expect((await call("owner", "POST", `/orders/${id}/payments`, { txId: good.id.toUpperCase() })).json().settlement).toHaveLength(1);
    const other = (await call("owner", "POST", "/orders", order())).json().id as string;
    expect((await call("owner", "POST", `/orders/${other}/payments`, { txId: good.id })).json()).toMatchObject({ error: "payment_used" });
    // An order under way cannot be cancelled; an untouched one can.
    expect((await call("owner", "POST", `/orders/${id}/cancel`)).statusCode).toBe(409);
    expect((await call("owner", "POST", `/orders/${other}/cancel`)).json().status).toBe("cancelled");
    expect((await call("manager", "GET", "/orders")).json().items.length).toBe(2);
  });
});
