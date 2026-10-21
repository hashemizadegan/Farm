/** Idempotency-Key on tenant-scoped writes (generic layer, migration 0021), against a real database. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("Idempotency-Key on tenant writes", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `i-owner-${sfx}`, manager: `i-manager-${sfx}`, outsider: `i-outsider-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  const auth = async (who: keyof typeof subjects, key?: string) => ({
    authorization: `Bearer ${await tokenFor(subjects[who])}`,
    ...(key ? { "idempotency-key": key } : {}),
  });
  const farms = () => `/v1/tenants/${tenantId}/farms`;
  const named = async (name: string) =>
    (await pool.query(`SELECT count(*)::int AS n FROM farms WHERE tenant_id = $1 AND name = $2`, [tenantId, name])).rows[0].n as number;
  const records = async (key: string) =>
    (await pool.query(`SELECT state FROM idempotency_records WHERE tenant_id = $1 AND key = $2`, [tenantId, key])).rows.map((r) => r.state as string);

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `idem-${sfx}`, name: "Idempotency", ownerUserId: ids.owner! }));
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'manager')`, [tenantId, ids.manager]);
    ({ app } = await buildTestApp({ pool }));
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("records a resent write once and replays the original response", async () => {
    const key = randomUUID();
    const name = `Replay ${sfx}`;
    const first = await app.inject({ method: "POST", url: farms(), headers: await auth("owner", key), payload: { name } });
    expect(first.statusCode).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    const again = await app.inject({ method: "POST", url: farms(), headers: await auth("owner", key), payload: { name } });
    expect(again.statusCode).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json()).toEqual(first.json());
    expect(await named(name)).toBe(1);
    expect(await records(key)).toEqual(["completed"]);
  });

  it("refuses a different request under a used key", async () => {
    const key = randomUUID();
    await app.inject({ method: "POST", url: farms(), headers: await auth("owner", key), payload: { name: `First ${sfx}` } });
    const other = await app.inject({ method: "POST", url: farms(), headers: await auth("owner", key), payload: { name: `Second ${sfx}` } });
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toBe("idempotency_key_reused");
    expect(await named(`Second ${sfx}`)).toBe(0);
  });

  it("scopes keys to the user: another member's identical key is a separate write", async () => {
    const key = randomUUID();
    const name = `Per user ${sfx}`;
    expect((await app.inject({ method: "POST", url: farms(), headers: await auth("owner", key), payload: { name } })).statusCode).toBe(201);
    const theirs = await app.inject({ method: "POST", url: farms(), headers: await auth("manager", key), payload: { name } });
    expect(theirs.statusCode).toBe(201);
    expect(theirs.headers["idempotent-replayed"]).toBeUndefined();
    expect(await named(name)).toBe(2);
  });

  it("releases the key when the write fails, so the client can fix and retry it", async () => {
    const key = randomUUID();
    const bad = await app.inject({ method: "POST", url: farms(), headers: await auth("owner", key), payload: { name: "" } });
    expect(bad.statusCode).toBe(400);
    expect(await records(key)).toEqual([]);
    // Same key, corrected body: a new request, since the first one recorded nothing.
    const ok = await app.inject({ method: "POST", url: farms(), headers: await auth("owner", key), payload: { name: `Fixed ${sfx}` } });
    expect(ok.statusCode).toBe(201);
  });

  it("never runs two concurrent requests with one key", async () => {
    const key = randomUUID();
    const name = `Concurrent ${sfx}`;
    const send = async () => app.inject({ method: "POST", url: farms(), headers: await auth("owner", key), payload: { name } });
    const codes = (await Promise.all([send(), send(), send()])).map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201).length).toBeGreaterThanOrEqual(1);
    expect(codes.every((c) => c === 201 || c === 409)).toBe(true);
    expect(await named(name)).toBe(1);
  });

  it("refuses a resend while the first request's outcome is unknown", async () => {
    const key = randomUUID();
    const name = `Unknown ${sfx}`;
    const first = await app.inject({ method: "POST", url: farms(), headers: await auth("owner", key), payload: { name } });
    expect(first.statusCode).toBe(201);
    // As if the process stopped after the write committed but before the response was stored.
    await pool.query(
      `UPDATE idempotency_records SET state = 'pending', status_code = NULL, completed_at = NULL, content_type = NULL, response_body = NULL WHERE tenant_id = $1 AND key = $2`,
      [tenantId, key],
    );
    const again = await app.inject({ method: "POST", url: farms(), headers: await auth("owner", key), payload: { name } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("idempotency_request_in_progress");
    expect(await named(name)).toBe(1);
  });

  it("reserves nothing for a caller outside the tenant, and rejects malformed keys", async () => {
    const key = randomUUID();
    const r = await app.inject({ method: "POST", url: farms(), headers: await auth("outsider", key), payload: { name: `Outside ${sfx}` } });
    expect(r.statusCode).toBe(404);
    expect(await records(key)).toEqual([]);
    const malformed = await app.inject({ method: "POST", url: farms(), headers: await auth("owner", "not-a-uuid"), payload: { name: `Bad key ${sfx}` } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toBe("invalid_idempotency_key");
  });

  it("leaves writes without the header unchanged", async () => {
    const name = `No key ${sfx}`;
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: "POST", url: farms(), headers: await auth("owner"), payload: { name } })).statusCode).toBe(201);
    expect(await named(name)).toBe(2);
  });

  it("lets the application role see only its tenant's records", async () => {
    const { rows } = await withSystem(pool, async (tx) => {
      await tx.query("SET LOCAL ROLE metafarm_app");
      await tx.query("SELECT set_config('app.tenant_id', $1, true)", [randomUUID()]);
      return tx.query(`SELECT count(*)::int AS n FROM idempotency_records WHERE tenant_id = $1`, [tenantId]);
    });
    expect(rows[0].n).toBe(0);
  });
});
