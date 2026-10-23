/**
 * Authenticated realtime channel against a real database and a listening server: handshake authentication, permission
 * and scope checks, workspace and farm isolation, replay from a cursor in order, reconnect without loss or repeat,
 * idempotent re-subscribe, heartbeat timeout, malformed frames, membership loss, and the outbox's own guarantees.
 */
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { appendRealtimeEvent, createPool, createTenantWithOwner, migrateUp, pruneRealtimeEvents, upsertUserBySubject, withSystem, withTenant, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";
import { connectRealtime, upgradeStatus, type RealtimeTestClient } from "./test/realtime-client";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("realtime channel (WebSocket)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let port: number;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { ownerA: `rt-a-${sfx}`, viewerA: `rt-va-${sfx}`, ownerB: `rt-b-${sfx}`, leaver: `rt-l-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantA: string;
  let tenantB: string;
  let farmA1: string;
  let farmA2: string;
  let farmB1: string;
  const clients: RealtimeTestClient[] = [];

  const twin = (tenantId: string, farmId: string) => ({
    scheme: "metafarm-event/1",
    type: "twin.snapshot.recorded",
    schemaVersion: 1,
    id: randomUUID(),
    scope: { tenantId, farmId },
    occurredAt: new Date().toISOString(),
    correlationId: null,
    payload: { commitmentId: randomUUID(), sha256: "a".repeat(64) },
  });
  const append = (tenantId: string, e: unknown) => withTenant(pool, tenantId, (tx) => appendRealtimeEvent(tx, e));
  const latest = async (tenantId: string) => (await pool.query<{ s: string | null }>(`SELECT max(seq)::text AS s FROM realtime_events WHERE tenant_id = $1`, [tenantId])).rows[0]!.s ?? "0";
  const open = async (who: keyof typeof subjects, opts?: { ping?: boolean }) => {
    const c = await connectRealtime(port, await tokenFor(subjects[who]), opts);
    clients.push(c);
    return c;
  };
  const sub = (tenantId: string, farmId: string | null, types: string[], after: string | null) => ({ op: "subscribe", tenantId, farmId, types, after });

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 8 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantA = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `rt-a-${sfx}`, name: "RT A", ownerUserId: ids.ownerA! }));
    tenantB = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `rt-b-${sfx}`, name: "RT B", ownerUserId: ids.ownerB! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'viewer'), ($1, $3, 'viewer')`, [tenantA, ids.viewerA, ids.leaver]);
    ({ app } = await buildTestApp({
      pool,
      env: { REALTIME_EVENTS_ENABLED: "true" },
      realtime: { pollIntervalMs: 50, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 400, subscribeTimeoutMs: 2_000, batchSize: 3 },
    }));
    const farm = async (who: "ownerA" | "ownerB", tenantId: string, name: string) =>
      (await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/farms`, headers: { authorization: `Bearer ${await tokenFor(subjects[who])}` }, payload: { name } })).json().id as string;
    farmA1 = await farm("ownerA", tenantA, "A1");
    farmA2 = await farm("ownerA", tenantA, "A2");
    farmB1 = await farm("ownerB", tenantB, "B1");
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) c.close();
    await app?.close();
    await pool?.end();
  });

  it("authenticates during the handshake: no token or a bad token gets HTTP 401 and no socket", async () => {
    expect(await upgradeStatus(port, {})).toBe(401);
    expect(await upgradeStatus(port, { authorization: "Bearer not-a-token" })).toBe(401);
    expect(await upgradeStatus(port, { "sec-websocket-protocol": "metafarm-realtime.1, bearer.not-a-token" })).toBe(401);
    // A native client sends the header; a browser-like client the subprotocol (never echoed back).
    expect(await upgradeStatus(port, { authorization: `Bearer ${await tokenFor(subjects.ownerA)}` })).toBe(101);
    const c = await open("ownerA");
    expect(c.protocol).toBe("metafarm-realtime.1");
  });

  it("refuses malformed frames and subscriptions with an error envelope and close code", async () => {
    const cases: [string, string, number][] = [
      ["not json", "malformed", 4400],
      [JSON.stringify(sub(tenantA, null, ["no.such.type"], null)), "unknown_type", 4400],
      [JSON.stringify({ ...sub(tenantA, null, ["yield.cycle.updated"], null), extra: 1 }), "malformed", 4400],
      [JSON.stringify(sub(tenantA, null, ["yield.cycle.updated"], "-1")), "malformed", 4400],
      [JSON.stringify(sub(tenantA, farmA1, ["yield.cycle.updated"], null)), "farm_scope_required", 4400],
      [JSON.stringify({ op: "transfer", assetId: "x" }), "malformed", 4400],
    ];
    for (const [frame, code, close] of cases) {
      const c = await open("ownerA");
      c.sendRaw(frame);
      expect((await c.next((m) => m.op === "error")).code, frame).toBe(code);
      expect((await c.closed).code, frame).toBe(close);
    }
    const big = await open("ownerA");
    big.sendRaw(JSON.stringify({ op: "ping", pad: "x".repeat(5_000) }));
    expect((await big.closed).code).toBe(1009);
  });

  it("refuses types the member's role cannot read, and workspaces or farms outside their reach (not found)", async () => {
    const viewer = await open("viewerA");
    viewer.send(sub(tenantA, null, ["yield.cycle.updated"], null));
    expect(await viewer.next((m) => m.op === "error")).toMatchObject({ code: "forbidden", close: true });
    expect((await viewer.closed).code).toBe(4403);

    const other = await open("ownerA");
    other.send(sub(tenantB, null, ["twin.snapshot.recorded"], null));
    expect(await other.next((m) => m.op === "error")).toMatchObject({ code: "not_found" });
    expect((await other.closed).code).toBe(4404);

    const foreignFarm = await open("ownerA");
    foreignFarm.send(sub(tenantA, farmB1, ["twin.snapshot.recorded"], null));
    expect(await foreignFarm.next((m) => m.op === "error")).toMatchObject({ code: "not_found" });
    expect((await foreignFarm.closed).code).toBe(4404);
  });

  it("replays after the cursor in order, then delivers live events, never another workspace's or farm's", async () => {
    const from = await latest(tenantA);
    const sent: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = twin(tenantA, farmA1);
      sent.push(e.id);
      await append(tenantA, e);
      await append(tenantA, twin(tenantA, farmA2)); // other farm, same workspace
      await append(tenantB, twin(tenantB, farmB1)); // other workspace
    }
    const c = await open("viewerA");
    c.send(sub(tenantA, farmA1, ["twin.snapshot.recorded"], from));
    expect(await c.next((m) => m.op === "subscribed")).toMatchObject({ tenantId: tenantA, farmId: farmA1, cursor: from });
    await c.next(() => c.events().length >= 5);
    const live = twin(tenantA, farmA1);
    await append(tenantA, live);
    await append(tenantB, twin(tenantB, farmB1));
    await c.next(() => c.events().length >= 6);
    await new Promise((r) => setTimeout(r, 200));
    const events = c.events() as unknown as { cursor: string; event: { id: string; scope: { tenantId: string; farmId: string } } }[];
    expect(events.map((e) => e.event.id)).toEqual([...sent, live.id]);
    expect(events.every((e) => e.event.scope.tenantId === tenantA && e.event.scope.farmId === farmA1)).toBe(true);
    const cursors = events.map((e) => BigInt(e.cursor));
    expect(cursors.every((x, i) => i === 0 || x > cursors[i - 1]!)).toBe(true);
  });

  it("a workspace subscription sees every farm of its workspace and nothing of another", async () => {
    const from = await latest(tenantA);
    const a1 = twin(tenantA, farmA1);
    const a2 = twin(tenantA, farmA2);
    await append(tenantA, a1);
    await append(tenantB, twin(tenantB, farmB1));
    await append(tenantA, a2);
    const c = await open("ownerA");
    c.send(sub(tenantA, null, ["twin.snapshot.recorded"], from));
    await c.next(() => c.events().length >= 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(c.events().map((m) => (m.event as { id: string }).id)).toEqual([a1.id, a2.id]);
  });

  it("resumes from the last processed cursor after a reconnect, without loss or repeat", async () => {
    const from = await latest(tenantA);
    const all = Array.from({ length: 7 }, () => twin(tenantA, farmA1));
    for (const e of all.slice(0, 4)) await append(tenantA, e);
    const first = await open("ownerA");
    first.send(sub(tenantA, farmA1, ["twin.snapshot.recorded"], from));
    await first.next(() => first.events().length >= 4);
    const last = first.events()[3]!.cursor as string;
    first.close();
    await first.closed;
    for (const e of all.slice(4)) await append(tenantA, e);
    const again = await open("ownerA");
    again.send(sub(tenantA, farmA1, ["twin.snapshot.recorded"], last));
    await again.next(() => again.events().length >= 3);
    await new Promise((r) => setTimeout(r, 200));
    const seen = [...first.events(), ...again.events()].map((m) => (m.event as { id: string }).id);
    expect(seen).toEqual(all.map((e) => e.id));
  });

  it("answers a repeated subscribe again (idempotent) and refuses a different one on the same connection", async () => {
    const c = await open("ownerA");
    const request = sub(tenantA, farmA1, ["twin.snapshot.recorded", "alert.raised"], await latest(tenantA));
    c.send(request);
    await c.next((m) => m.op === "subscribed");
    c.send({ ...request, types: ["alert.raised", "twin.snapshot.recorded"] });
    await c.next((m) => m.op === "subscribed", 2_000, c.messages.findIndex((m) => m.op === "subscribed") + 1);
    const e = twin(tenantA, farmA1);
    await append(tenantA, e);
    await c.next(() => c.events().length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(c.events()).toHaveLength(1);
    c.send(sub(tenantA, farmA2, ["twin.snapshot.recorded"], null));
    expect(await c.next((m) => m.op === "error")).toMatchObject({ code: "already_subscribed" });
    expect((await c.closed).code).toBe(4409);
  });

  it("sends heartbeats, answers pings and closes a silent client with 4408", async () => {
    const live = await open("ownerA");
    live.send({ op: "ping" });
    await live.next((m) => m.op === "pong");
    live.send(sub(tenantA, null, ["twin.snapshot.recorded"], null));
    await live.next((m) => m.op === "heartbeat");

    const silent = await open("ownerA", { ping: false });
    silent.send(sub(tenantA, null, ["twin.snapshot.recorded"], null));
    expect(await silent.next((m) => m.op === "error", 3_000)).toMatchObject({ code: "heartbeat_timeout" });
    expect((await silent.closed).code).toBe(4408);
  });

  it("ends the stream when the member is removed", async () => {
    const c = await open("leaver");
    c.send(sub(tenantA, farmA1, ["twin.snapshot.recorded"], null));
    await c.next((m) => m.op === "subscribed");
    await pool.query(`DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantA, ids.leaver]);
    expect(await c.next((m) => m.op === "error", 3_000)).toMatchObject({ code: "forbidden" });
    expect((await c.closed).code).toBe(4403);
  });

  it("a cursor older than retained history gets an explicit resync, then the stream continues from the newest cursor", async () => {
    const before = await latest(tenantA);
    await append(tenantA, twin(tenantA, farmA1));
    // An already expired event after the client's cursor, removed by retention: the client can no longer replay it.
    await pool.query(
      `INSERT INTO realtime_events (id, tenant_id, farm_id, type, schema_version, payload, occurred_at, created_at, expires_at)
       VALUES ($1, $2, $3, 'twin.snapshot.recorded', 1, $4::jsonb, now(), now() - interval '10 days', now() - interval '1 day')`,
      [randomUUID(), tenantA, farmA1, JSON.stringify({ commitmentId: randomUUID(), sha256: "b".repeat(64) })],
    );
    await append(tenantA, twin(tenantA, farmA1));
    await withSystem(pool, (tx) => pruneRealtimeEvents(tx, 1_000));
    const horizon = (await pool.query<{ s: string }>(`SELECT pruned_through_seq::text AS s FROM realtime_retention_horizons WHERE tenant_id = $1`, [tenantA])).rows[0]!.s;
    expect(BigInt(horizon)).toBeGreaterThan(BigInt(before));

    const stale = await open("ownerA");
    stale.send(sub(tenantA, farmA1, ["twin.snapshot.recorded"], before));
    const resync = await stale.next((m) => m.op === "resync");
    expect(resync).toMatchObject({ reason: "cursor_expired", cursor: await latest(tenantA) });
    const ack = await stale.next((m) => m.op === "subscribed");
    expect(ack.cursor).toBe(resync.cursor);
    // Recovery: the client refreshes from the API (here: the events it would have replayed are not pushed again) ...
    await new Promise((r) => setTimeout(r, 200));
    expect(stale.events()).toHaveLength(0);
    // ... and everything after the resync point still arrives.
    const next = twin(tenantA, farmA1);
    await append(tenantA, next);
    expect(((await stale.next((m) => m.op === "event")).event as { id: string }).id).toBe(next.id);

    // A cursor at or after the horizon replays normally, without a resync.
    const fresh = await open("ownerA");
    fresh.send(sub(tenantA, farmA1, ["twin.snapshot.recorded"], horizon));
    await fresh.next((m) => m.op === "subscribed");
    await fresh.next(() => fresh.events().length >= 2);
    expect(fresh.messages.some((m) => m.op === "resync")).toBe(false);
  });

  it("outbox: validated, idempotent on the event id, bound to its workspace, immutable", async () => {
    const e = twin(tenantA, farmA1);
    const seq = await append(tenantA, e);
    expect(await append(tenantA, e)).toBe(seq);
    await expect(append(tenantB, e)).rejects.toThrow(/workspace/);
    await expect(append(tenantA, { ...twin(tenantA, farmA1), payload: { commitmentId: "x" } })).rejects.toThrow();
    await expect(append(tenantA, { ...twin(tenantA, farmA1), scope: { tenantId: tenantA, farmId: null } })).rejects.toThrow(/farm-scoped/);
    await expect(pool.query(`UPDATE realtime_events SET type = 'alert.raised' WHERE seq = $1`, [seq])).rejects.toThrow();
  });
});
