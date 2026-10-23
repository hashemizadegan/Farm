/**
 * End to end, without changing established behaviour:
 * 1. a registered sensor integration posts a signed event; it is authorized (integration, signature, workspace) and
 *    stored as raw observations in the existing pipeline; the worker's own normalization handler then produces
 *    observations that the polling API serves;
 * 2. with the realtime channel on, the same transaction puts a `sensor.reading.received` event in the outbox and an
 *    authenticated client subscribed to that farm receives it (a direct sensor's readings too);
 * 3. with the channel off, nothing is written to the outbox and polling works exactly as before;
 * 4. chain webhooks (here through the CI fixture adapter) still only ask the indexer to re-read a tracked asset:
 *    no ownership row is written by the webhook, a duplicate delivery is harmless, and delayed finality waits.
 */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { base58Encode } from "@metafarm/chain";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { QUEUES, type ObservationNormalizationJob } from "@metafarm/domain";
import { signWebhook } from "@metafarm/domain/server";
import { createLogger } from "@metafarm/observability";
import { observationNormalizationHandler } from "../../worker/src/handlers/observations";
import type { createMemoryProducer } from "./queue/producer";
import { buildTestApp, tokenFor } from "./test/helpers";
import { connectRealtime, type RealtimeTestClient } from "./test/realtime-client";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const KEY = "integration-key-for-e2e-tests-0123456789ab";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/domain/fixtures/chain-events");

d("sensor integration → observation pipeline → realtime outbox → client; chain hints unchanged", () => {
  let pool: Pool;
  let on: FastifyInstance;
  let off: FastifyInstance;
  let jobsOn: ReturnType<typeof createMemoryProducer>;
  let jobsOff: ReturnType<typeof createMemoryProducer>;
  let port: number;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `e2e-o-${sfx}`, viewer: `e2e-v-${sfx}` };
  let tenantId: string;
  let farmId: string;
  let sensorId: string;
  let sensorToken: string;
  let feed: { id: string; secret: string };
  const tracked = base58Encode(randomBytes(32));
  const clients: RealtimeTestClient[] = [];
  const reading = { metric: "soil_moisture", value: 0.24, unit: "fraction_vwc", observedAt: "2026-10-23T02:00:00Z" };
  const auth = async (who: keyof typeof subjects) => ({ authorization: `Bearer ${await tokenFor(subjects[who])}` });
  const postIntegration = (app: FastifyInstance, id: string) => {
    const raw = JSON.stringify({ scheme: "metafarm-integration-event/1", id, type: "sensor.readings", sensorId, readings: [reading, { ...reading, metric: "air_temperature", value: 17.5, unit: "celsius" }] });
    return app.inject({
      method: "POST",
      url: `/v1/integrations/${feed.id}/events`,
      headers: { "content-type": "application/json", "x-webhook-signature": signWebhook(feed.secret, raw, Math.floor(Date.now() / 1000)) },
      payload: raw,
    });
  };
  const outboxCount = async () => Number((await pool.query(`SELECT count(*) FROM realtime_events WHERE tenant_id = $1`, [tenantId])).rows[0].count);
  const runPipeline = async (jobs: ReturnType<typeof createMemoryProducer>) => {
    const handler = observationNormalizationHandler(pool);
    const ctx = { log: createLogger({ service: "e2e", level: "silent" }), attempt: 1, jobId: "e2e" };
    for (const j of jobs.jobs.filter((x) => x.queue === QUEUES.observations && (x.payload as ObservationNormalizationJob).tenantId === tenantId)) {
      await handler(j.payload as ObservationNormalizationJob, ctx);
    }
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 8 });
    await migrateUp(pool);
    const ids: Record<string, string> = {};
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `e2e-${sfx}`, name: "E2E", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'viewer')`, [tenantId, ids.viewer]);
    const env = { INTEGRATION_SECRET_KEY: KEY, CHAIN_EVENT_PROVIDERS: "metafarm-fixture", TWIN_OWNERSHIP_INDEX_ENABLED: "true" };
    let built = await buildTestApp({ pool, env: { ...env, REALTIME_EVENTS_ENABLED: "true" }, realtime: { pollIntervalMs: 50, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 2_000 } });
    on = built.app;
    jobsOn = built.jobs as ReturnType<typeof createMemoryProducer>;
    built = await buildTestApp({ pool, env });
    off = built.app;
    jobsOff = built.jobs as ReturnType<typeof createMemoryProducer>;

    farmId = (await on.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: await auth("owner"), payload: { name: "E2E farm" } })).json().id;
    const s = (await on.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms/${farmId}/sensors`, headers: await auth("owner"), payload: { name: "probe", kind: "soil-moisture" } })).json();
    sensorId = s.sensor.id;
    sensorToken = s.token;
    const r = (
      await on.inject({ method: "POST", url: `/v1/tenants/${tenantId}/integrations`, headers: await auth("owner"), payload: { kind: "sensor_feed", provider: "e2e-probes", name: "E2E probes", allowedEventTypes: ["sensor.readings"] } })
    ).json();
    feed = { id: r.integration.id, secret: r.secret };
    const assetId = (await on.inject({ method: "POST", url: `/v1/tenants/${tenantId}/rwa/assets`, headers: await auth("owner"), payload: { farmId, kind: "building", name: "Barn" } })).json().id;
    await pool.query(
      `INSERT INTO asset_representations (tenant_id, asset_id, rail, network, status, mint_address, decimals) VALUES ($1, $2, 'SOLANA_TOKEN_2022', 'solana-devnet', 'active', $3, 6)`,
      [tenantId, assetId, tracked],
    );
    await on.listen({ port: 0, host: "127.0.0.1" });
    port = (on.server.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) c.close();
    await Promise.all([on?.close(), off?.close()]);
    await pool?.end();
  });

  it("realtime on: the authorized integration event is stored, processed by the pipeline and pushed to a subscribed client", async () => {
    const client = await connectRealtime(port, await tokenFor(subjects.viewer));
    clients.push(client);
    client.send({ op: "subscribe", tenantId, farmId, types: ["sensor.reading.received"], after: null });
    await client.next((m) => m.op === "subscribed");

    const r = await postIntegration(on, `e2e-on-${sfx}`);
    expect([r.statusCode, r.json().accepted]).toEqual([202, 2]);
    const pushed = (await client.next((m) => m.op === "event")).event as { type: string; scope: { tenantId: string; farmId: string }; payload: { sensorId: string; rawObservationIds: string[]; metrics: string[]; source: string } };
    expect(pushed.type).toBe("sensor.reading.received");
    expect(pushed.scope).toEqual({ tenantId, farmId });
    expect(pushed.payload).toMatchObject({ sensorId, source: "integration", metrics: ["soil_moisture", "air_temperature"] });
    expect(pushed.payload.rawObservationIds).toHaveLength(2);

    // The existing pipeline (the worker's own handler) normalizes them; the polling API serves the result.
    await runPipeline(jobsOn);
    const items = (await on.inject({ method: "GET", url: `/v1/tenants/${tenantId}/farms/${farmId}/observations`, headers: await auth("viewer") })).json().items as { sensorId: string; provenance: string; metric: string }[];
    const mine = items.filter((o) => o.sensorId === sensorId && o.provenance === "provider-observation");
    expect(mine.map((o) => o.metric).sort()).toEqual(["air_temperature", "soil_moisture"]);

    // A device posting directly is announced the same way.
    const direct = await on.inject({ method: "POST", url: "/v1/ingest/readings", headers: { authorization: `Sensor ${sensorToken}` }, payload: { readings: [reading] } });
    expect(direct.statusCode).toBe(202);
    const second = await client.next((m) => m.op === "event" && (m.event as { payload: { source: string } }).payload.source === "sensor");
    expect((second.event as { payload: { rawObservationIds: string[] } }).payload.rawObservationIds).toHaveLength(1);
  });

  it("realtime off: the outbox stays untouched and polling works as before", async () => {
    const before = await outboxCount();
    const r = await postIntegration(off, `e2e-off-${sfx}`);
    expect([r.statusCode, r.json().accepted]).toEqual([202, 2]);
    expect(await outboxCount()).toBe(before);
    expect(off.hasRoute({ method: "GET", url: "/v1/realtime" })).toBe(false);
    await runPipeline(jobsOff);
    const items = (await off.inject({ method: "GET", url: `/v1/tenants/${tenantId}/farms/${farmId}/observations`, headers: await auth("viewer") })).json().items as { sensorId: string; provenance: string }[];
    expect(items.filter((o) => o.sensorId === sensorId && o.provenance === "provider-observation").length).toBeGreaterThanOrEqual(4);
  });

  it("chain webhooks still only ask the indexer to re-read: never a direct ownership write; duplicates and delayed finality are safe", async () => {
    const delivery = (file: string) => {
      const body = JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8")) as { deliveryId: string; events: { asset: string }[] };
      body.deliveryId = `${body.deliveryId}-${sfx}`;
      for (const e of body.events) e.asset = tracked;
      const raw = JSON.stringify(body);
      return on.inject({
        method: "POST",
        url: "/v1/webhooks/metafarm-fixture",
        headers: { "content-type": "application/json", "x-webhook-signature": signWebhook("whsec_test", raw, Math.floor(Date.now() / 1000)) },
        payload: raw,
      });
    };
    const hints = () => jobsOn.jobs.filter((j) => j.queue === QUEUES.ownershipIndex && (j.payload as { assetId: string }).assetId === tracked).length;

    const first = await delivery("ownership.json");
    expect([first.statusCode, first.json().events]).toEqual([202, [{ kind: "ownership_change", reindex: "queued" }]]);
    expect([(await delivery("duplicate.json")).json().status, hints()]).toEqual(["duplicate", 1]);
    expect((await delivery("delayed-finality-processed.json")).json().events[0].reindex).toBe("awaiting_finality");
    expect((await delivery("delayed-finality-confirmed.json")).json().events[0].reindex).toBe("awaiting_finality");
    expect((await delivery("delayed-finality-finalized.json")).json().events[0].reindex).toBe("queued");
    expect((await delivery("wrong-network.json")).json().error).toBe("chain_event_unsupported_network");
    expect((await delivery("malformed.json")).json().error).toBe("chain_event_malformed");
    // The webhook wrote no ownership: only the indexer (from the verified chain source) ever does.
    expect((await pool.query(`SELECT 1 FROM chain_ownership_events WHERE asset_id = $1`, [tracked])).rowCount).toBe(0);
    // Chain events never enter the realtime outbox.
    expect((await pool.query(`SELECT 1 FROM realtime_events WHERE tenant_id = $1 AND type NOT LIKE 'sensor.%'`, [tenantId])).rowCount).toBe(0);
  });
});
