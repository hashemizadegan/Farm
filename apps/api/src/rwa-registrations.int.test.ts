/** Registrations: verified one-of-a-kind assets as compressed NFTs, approved by a second person. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { base58Encode } from "@metafarm/chain";
import {
  createPool,
  createTenantWithOwner,
  migrateUp,
  upsertUserBySubject,
  withSystem,
  type Pool,
} from "@metafarm/db";
import { buildTestApp, tokenFor } from "./test/helpers";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const CUSTODY = base58Encode(new Uint8Array(32).fill(9));
const UNSCREENED = base58Encode(new Uint8Array(32).fill(10));
const BASE = "https://api.example.com";

d("RWA registrations API", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sfx = Math.random().toString(36).slice(2, 8);
  const subjects = { owner: `rr-owner-${sfx}`, admin: `rr-admin-${sfx}` };
  const ids: Record<string, string> = {};
  let tenantId: string;
  let farmId: string;
  let partyId: string;
  const call = async (who: keyof typeof subjects, method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({
      method,
      url: `/v1/tenants/${tenantId}/rwa${path}`,
      headers: { authorization: `Bearer ${await tokenFor(subjects[who])}` },
      ...(payload ? { payload } : {}),
    });

  /** A tree asset with surveyed geometry, verified by the admin unless `verify: false`. */
  async function treeAsset(name: string, verify = true): Promise<string> {
    const a = await call("owner", "POST", "/assets", {
      farmId,
      kind: "tree",
      name,
      geometry: { type: "Point", coordinates: [56.0123, 30.4567] },
      geomProvenance: "gnss",
    });
    expect(a.statusCode).toBe(201);
    if (verify) expect((await call("admin", "POST", `/assets/${a.json().id}/verify`)).statusCode).toBe(200);
    return a.json().id as string;
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, max: 5 });
    await migrateUp(pool);
    for (const [k, s] of Object.entries(subjects))
      ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: s })).id;
    tenantId = await withSystem(pool, (tx) =>
      createTenantWithOwner(tx, { slug: `rr-${sfx}`, name: "Registrations", ownerUserId: ids.owner! }),
    );
    await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      tenantId,
      ids.admin,
    ]);
    ({ app } = await buildTestApp({ pool, env: { RWA_CNFT_METADATA_BASE_URL: BASE } }));
    farmId = (
      await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/farms`,
        headers: { authorization: `Bearer ${await tokenFor(subjects.owner)}` },
        payload: { name: "Grove" },
      })
    ).json().id;

    // A custodian with verified KYC, screened, and one screened Solana wallet (plus one unscreened).
    partyId = (
      await call("owner", "POST", "/parties", {
        kind: "organisation",
        displayName: "Grove Custody",
        jurisdiction: "AE",
      })
    ).json().id;
    await call("owner", "POST", `/parties/${partyId}/kyc`, {
      status: "verified",
      reference: "kyc-custody",
      expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    });
    const withWallet = await call("owner", "POST", `/parties/${partyId}/wallets`, {
      network: "solana-devnet",
      address: CUSTODY,
    });
    await call("owner", "POST", `/parties/${partyId}/wallets`, {
      network: "solana-devnet",
      address: UNSCREENED,
    });
    const now = new Date().toISOString();
    await call("owner", "POST", `/parties/${partyId}/screenings`, {
      provider: "provider",
      providerReference: "p-1",
      outcome: "clear",
      checkedAt: now,
    });
    const custodyWallet = (withWallet.json().wallets as { id: string; address: string }[]).find(
      (w) => w.address === CUSTODY,
    )!;
    await call("owner", "POST", `/parties/${partyId}/screenings`, {
      walletId: custodyWallet.id,
      provider: "provider",
      providerReference: "w-1",
      outcome: "clear",
      checkedAt: now,
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("registers only verified parcels, trees and animals, for a compliant custodian wallet", async () => {
    const shares = (
      await call("owner", "POST", "/assets", { farmId, kind: "farm_share", name: "Grove shares" })
    ).json().id;
    await call("admin", "POST", `/assets/${shares}/verify`);
    const body = { network: "solana-devnet", partyId, solanaWallet: CUSTODY };
    expect((await call("owner", "POST", `/assets/${shares}/registrations`, body)).json()).toMatchObject({
      error: "not_registrable",
    });
    const draft = await treeAsset("Pistachio draft", false);
    expect((await call("owner", "POST", `/assets/${draft}/registrations`, body)).json()).toMatchObject({
      error: "asset_not_verified",
    });
    const tree = await treeAsset("Pistachio A-17");
    expect(
      (
        await call("owner", "POST", `/assets/${tree}/registrations`, { ...body, network: "solana-mainnet" })
      ).json(),
    ).toMatchObject({ error: "network_not_enabled" });
    const blocked = await call("owner", "POST", `/assets/${tree}/registrations`, {
      ...body,
      solanaWallet: UNSCREENED,
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ error: "compliance_blocked" });
    expect(
      (
        await call("owner", "POST", `/assets/${tree}/registrations`, {
          ...body,
          solanaWallet: "not-an-address",
        })
      ).statusCode,
    ).toBe(400);

    const ok = await call("owner", "POST", `/assets/${tree}/registrations`, body);
    expect(ok.statusCode).toBe(201);
    const reg = ok.json();
    expect(reg).toMatchObject({
      status: "open",
      network: "solana-devnet",
      asset: { id: tree, kind: "tree" },
      custodian: { partyId, solanaWallet: CUSTODY },
      leaf: { status: "planned", tree: null, assetId: null },
    });
    expect(reg.leaf.metadataUri).toBe(`${BASE}/v1/public/rwa/cnft/${reg.leaf.representationId}`);
    expect((await call("owner", "POST", `/assets/${tree}/registrations`, body)).json()).toMatchObject({
      error: "already_registered",
    });

    // Registrations never appear among investor orders.
    const orders = (await call("owner", "GET", "/orders")).json().items as { id: string }[];
    expect(orders.map((o) => o.id)).not.toContain(reg.id);
    expect((await call("owner", "GET", `/orders/${reg.id}`)).statusCode).toBe(404);
  });

  it("needs a second person to approve the mint", async () => {
    const tree = await treeAsset("Walnut B-2");
    const reg = (
      await call("owner", "POST", `/assets/${tree}/registrations`, {
        network: "solana-devnet",
        partyId,
        solanaWallet: CUSTODY,
      })
    ).json();
    expect((await call("owner", "POST", `/registrations/${reg.id}/approve`)).json()).toMatchObject({
      error: "four_eyes",
    });
    const approved = await call("admin", "POST", `/registrations/${reg.id}/approve`);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "issuing" });
    expect((await call("admin", "POST", `/registrations/${reg.id}/approve`)).json()).toMatchObject({
      error: "registration_not_open",
    });
    expect((await call("admin", "GET", `/registrations/${reg.id}`)).json()).toMatchObject({
      id: reg.id,
      status: "issuing",
      cases: [],
    });
    expect(
      ((await call("admin", "GET", "/registrations")).json().items as { id: string }[]).map((r) => r.id),
    ).toContain(reg.id);
  });

  it("publishes the leaf's metadata without coordinates or the commitment's salt", async () => {
    const tree = await treeAsset("Almond C-3");
    const reg = (
      await call("owner", "POST", `/assets/${tree}/registrations`, {
        network: "solana-devnet",
        partyId,
        solanaWallet: CUSTODY,
      })
    ).json();
    const pub = await app.inject({ method: "GET", url: `/v1/public/rwa/cnft/${reg.leaf.representationId}` });
    expect(pub.statusCode).toBe(200);
    const doc = pub.json();
    expect(doc).toMatchObject({
      name: "Almond C-3",
      symbol: "TREE",
      properties: {
        network: "solana-devnet",
        commitment: { algorithm: "sha256", scheme: "metafarm-rwa-asset/1" },
      },
    });
    expect(doc.properties.commitment.hash).toMatch(/^[0-9a-f]{64}$/);
    const raw = pub.body;
    expect(raw).not.toContain("56.0123");
    expect(raw).not.toContain("30.4567");
    expect(raw).not.toContain("commitmentSalt");
    expect(
      (await app.inject({ method: "GET", url: `/v1/public/rwa/cnft/00000000-0000-4000-8000-000000000000` }))
        .statusCode,
    ).toBe(404);
  });
});
