/** Keyset pages on the RWA lists (parties, assets, registrations, orders) against a real database. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPool, createTenantWithOwner, migrateUp, upsertUserBySubject, withSystem, type Pool } from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d("RWA list pages", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const owner = `rwp-owner-${sfx}`;
  const other = `rwp-other-${sfx}`;
  let tenantId: string;
  let otherTenantId: string;
  let otherPartyId: string;

  const get = async (path: string, tenant = tenantId, who = owner) =>
    app.inject({ method: "GET", url: `/v1/tenants/${tenant}/rwa${path}`, headers: { authorization: `Bearer ${await tokenFor(who)}` } });
  const addParty = async (displayName: string, tenant = tenantId, who = owner) => {
    const r = await app.inject({ method: "POST", url: `/v1/tenants/${tenant}/rwa/parties`, headers: { authorization: `Bearer ${await tokenFor(who)}` }, payload: { kind: "person", displayName } });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    const ownerId = (await upsertUserBySubject(pool, { issuer: "dev", subject: owner })).id;
    const otherId = (await upsertUserBySubject(pool, { issuer: "dev", subject: other })).id;
    tenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `rwa-pages-${sfx}`, name: "Pages", ownerUserId: ownerId }));
    otherTenantId = await withSystem(pool, (tx) => createTenantWithOwner(tx, { slug: `rwa-pages-o-${sfx}`, name: "Other", ownerUserId: otherId }));
    ({ app } = await buildTestApp({ pool }));
    otherPartyId = await addParty("Elsewhere", otherTenantId, other);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("walks every investor exactly once, by name, including equal names", async () => {
    // Three equal names: the id breaks the tie, so pages neither repeat nor skip them.
    const created = [await addParty("Same"), await addParty("same"), await addParty("Same"), await addParty("Alpha"), await addParty("zeta")];
    const seen: string[] = [];
    const names: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await get(`/parties?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.statusCode).toBe(200);
      const body = r.json() as { items: { id: string; displayName: string }[]; nextCursor: string | null };
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((p) => p.id));
      names.push(...body.items.map((p) => p.displayName.toLowerCase()));
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...created].sort());
    expect(names).toEqual(["alpha", "same", "same", "same", "zeta"]);
    expect(seen).not.toContain(otherPartyId);

    const all = (await get("/parties")).json();
    expect(all.items.map((p: { id: string }) => p.id)).toEqual(seen);
    expect(all.nextCursor).toBeNull();
  });

  it("returns an empty last page with a null cursor for empty lists", async () => {
    for (const list of ["/assets", "/registrations", "/orders"]) {
      const r = await get(list);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ items: [], nextCursor: null });
    }
  });

  it("refuses a cursor that is not an item of this list or this tenant", async () => {
    const mine = (await get("/parties?limit=1")).json().nextCursor as string;
    for (const [path, cursor] of [
      ["/parties", randomUUID()],
      ["/parties", otherPartyId], // another tenant's party
      ["/orders", mine], // a party is not an order
      ["/registrations", mine],
      ["/assets", mine],
    ] as const) {
      const r = await get(`${path}?cursor=${cursor}`);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_cursor");
    }
  });

  it("validates the page parameters", async () => {
    for (const q of ["limit=0", "limit=101", "limit=x", "cursor=not-a-uuid", "page=2"]) {
      const r = await get(`/parties?${q}`);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_request");
    }
  });
});
