/**
 * Chain event webhooks end to end: idempotent receipts, an audit row with the normalized summary and the body's hash
 * (never the body), and a re-index hint for tracked assets only. The event never writes ownership.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { QUEUES } from "@metafarm/domain";
import { metadataUpdateData, ownershipChangeData, relayBody } from "@metafarm/domain/chain-events.fixtures";
import { signWebhook } from "@metafarm/domain/server";
import { base58Encode } from "@metafarm/chain";
import { buildTestApp, tokenFor } from "./test/helpers";
import type { createMemoryProducer } from "./queue/producer";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const b58 = (n: number) => base58Encode(randomBytes(n));

d("chain event webhooks (provider-neutral relay)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let off: FastifyInstance;
  let jobs: ReturnType<typeof createMemoryProducer>;
  const tracked = b58(32);
  const untracked = b58(32);
  const sfx = Math.random().toString(36).slice(2, 8);

  const post = (target: FastifyInstance, body: unknown) => {
    const raw = JSON.stringify(body);
    return target.inject({
      method: "POST",
      url: "/v1/webhooks/metafarm-relay",
      headers: { "content-type": "application/json", "x-webhook-signature": signWebhook("whsec_test", raw, Math.floor(Date.now() / 1000)) },
      payload: raw,
    });
  };
  const audits = async (eventId: string) =>
    (await pool.query<{ action: string; metadata: Record<string, unknown> }>(`SELECT action, metadata FROM audit_events WHERE metadata->>'eventId' = $1 ORDER BY id`, [eventId])).rows;
  const ownershipRows = async (asset: string) => (await pool.query(`SELECT 1 FROM chain_ownership_events WHERE asset_id = $1`, [asset])).rowCount;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    const owner = (await upsertUserBySubject(pool, { issuer: "dev", subject: `cw-owner-${sfx}` })).id;
    const tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `cw-${sfx}`, name: "CW", ownerUserId: owner }));
    let built = await buildTestApp({ pool, env: { CHAIN_EVENT_PROVIDERS: "metafarm-relay", TWIN_OWNERSHIP_INDEX_ENABLED: "true" } });
    app = built.app;
    jobs = built.jobs as ReturnType<typeof createMemoryProducer>;
    built = await buildTestApp({ pool, env: { CHAIN_EVENT_PROVIDERS: "metafarm-relay" } });
    off = built.app;
    const auth = { authorization: `Bearer ${await tokenFor(`cw-owner-${sfx}`)}` };
    const farmId = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: auth, payload: { name: "CW farm" } })).json().id;
    const assetId = (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/rwa/assets`, headers: auth, payload: { farmId, kind: "building", name: "Shed" } })).json().id;
    await pool.query(
      `INSERT INTO asset_representations (tenant_id, asset_id, rail, network, status, mint_address, decimals) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'solana-devnet', 'active', $3, 6)`,
      [tenantId, assetId, tracked],
    );
  });
  afterAll(async () => {
    await Promise.all([app?.close(), off?.close()]);
    await pool?.end();
  });

  it("accepts an event for a tracked asset once, audits it with the body hash, and asks the indexer to re-read it", async () => {
    const id = `evt-${sfx}-1`;
    const body = relayBody(id, ownershipChangeData({ assetId: tracked }));
    const first = await post(app, body);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ status: "accepted", events: [{ kind: "ownership_change", reindex: "queued" }] });
    const second = await post(app, body);
    expect([second.statusCode, second.json().status]).toEqual([200, "duplicate"]);

    const hints = jobs.jobs.filter((j) => j.queue === QUEUES.ownershipIndex && (j.payload as { assetId: string }).assetId === tracked);
    expect(hints).toHaveLength(1);
    expect(hints[0]!.payload).toMatchObject({ network: "solana-devnet", rail: "SOLANA_TOKEN_2022", assetId: tracked });

    const rows = await audits(id);
    expect(rows.map((r) => r.action)).toEqual(["webhook.received"]);
    expect(rows[0]!.metadata.payloadSha256).toBe(createHash("sha256").update(JSON.stringify(body)).digest("hex"));
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain('"ownership"'); // the body is not kept, only the summary
    // The event itself never wrote ownership: only the indexer, from the verified chain source, does.
    expect(await ownershipRows(tracked)).toBe(0);
  });

  it("records untracked assets, metadata updates and processed (unconfirmed) changes without any re-index", async () => {
    const cases: [unknown, string][] = [
      [relayBody(`evt-${sfx}-2`, ownershipChangeData({ assetId: untracked })), "not_tracked"],
      [relayBody(`evt-${sfx}-3`, metadataUpdateData({ assetId: tracked })), "not_an_ownership_hint"],
      [relayBody(`evt-${sfx}-4`, ownershipChangeData({ assetId: tracked, finality: "processed" })), "not_an_ownership_hint"],
    ];
    const before = jobs.jobs.length;
    for (const [body, reindex] of cases) {
      const r = await post(app, body);
      expect([r.statusCode, r.json().events[0].reindex], reindex).toEqual([202, reindex]);
    }
    expect(jobs.jobs.length).toBe(before);
  });

  it("does not enqueue anything while the ownership indexer is off", async () => {
    const r = await post(off, relayBody(`evt-${sfx}-5`, ownershipChangeData({ assetId: tracked, transaction: { signature: b58(64), slot: "5", ixIndex: 0 } })));
    expect(r.json().events[0].reindex).toBe("indexer_disabled");
  });

  it("stores nothing for a refused event (no receipt: a corrected resend with the same id is accepted)", async () => {
    const id = `evt-${sfx}-6`;
    const bad = await post(app, relayBody(id, ownershipChangeData({ assetId: tracked, network: "solana-mainnet" })));
    expect(bad.json().error).toBe("chain_event_network_mismatch");
    expect((await pool.query(`SELECT 1 FROM webhook_receipts WHERE provider = 'metafarm-relay' AND event_id = $1`, [id])).rowCount).toBe(0);
    const good = await post(app, relayBody(id, ownershipChangeData({ assetId: untracked })));
    expect(good.statusCode).toBe(202);
  });
});
