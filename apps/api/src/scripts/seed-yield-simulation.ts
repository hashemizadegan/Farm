/**
 * Local development seed for the operator yield pages (`/yield`): three **simulation** cycles of one asset in the
 * demo workspace (run `pnpm db:seed` first), driven through the real workflow routes in-process, so every rule
 * applies: the database triggers, four-eyes, the yield pipeline engine, frozen artifacts, carry-forward and claim
 * intents built from stored leaves.
 *
 *   Q1 2026: published, with a claim-intent batch (one party's dust is deferred and carried forward);
 *   Q2 2026: published, carry-in = Q1's carry-out, with a claim-intent batch;
 *   Q3 2026: calculated (frozen), submitted and attested, awaiting a four-eyes approval.
 *
 * Simulation data only: fixture ownership in the platform index, simulation-labelled records, nothing signed or
 * submitted, no chain contacted. Refused unless APP_ENV is development or test. Idempotent: a second run reports the
 * existing cycles and changes nothing.
 *
 * Usage: pnpm --filter @metafarm/api seed:yield
 */
import { randomBytes } from "node:crypto";
import { apiEnvSchema } from "@metafarm/config";
import { base58Encode } from "@metafarm/chain";
import { addWallet, advanceOwnershipCursor, createFarm, createParty, createPool, insertOwnershipEvents, upsertUserBySubject, withSystem, withTenant } from "@metafarm/db";
import type { ChainAssetRef, OwnershipEvent } from "@metafarm/domain";
import { calculationPolicyHash, canonicalSimulationDossier } from "@metafarm/domain/yield";
import { createLogger } from "@metafarm/observability";
import { createMemoryStorage } from "@metafarm/storage";
import { buildApp } from "../app";
import { createDevProvider, mintDevToken } from "../auth/dev";
import { createPipelineYieldEngine } from "../lib/yield-pipeline-engine";
import { createMemoryProducer } from "../queue/producer";
import { POLICY, dossierFor, h } from "../test/yield-dossier";

const ASSET_NAME = "Yield simulation shares";
const SETTLE = "So11111111111111111111111111111111111111112";

if (process.env.APP_ENV !== "development" && process.env.APP_ENV !== "test") {
  console.error("[seed:yield] refused: APP_ENV must be development or test (simulation data, local only)");
  process.exit(1);
}
const secret = process.env.DEV_AUTH_SECRET;
if (!secret) {
  console.error("[seed:yield] DEV_AUTH_SECRET must be set (dev sign-in)");
  process.exit(1);
}

// The in-process app has the workflow switched on for this script only; the running API keeps its own settings.
const env = apiEnvSchema.parse({ ...process.env, YIELD_WORKFLOW_ENABLED: "true", YIELD_CLAIM_INTENTS_ENABLED: "true" });
const pool = createPool({ connectionString: env.DATABASE_URL, max: 4 });

async function main() {
  const tenant = (await pool.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'demo'`)).rows[0]?.id;
  if (!tenant) throw new Error("no demo workspace: run `pnpm db:seed` first");
  const existing = await pool.query<{ id: string; period_start: string; status: string }>(
    `SELECT c.id, c.period_start::text, c.status FROM yield_cycles c JOIN business_assets a ON a.tenant_id = c.tenant_id AND a.id = c.business_asset_id
      WHERE c.tenant_id = $1 AND a.name = $2 ORDER BY c.period_start`,
    [tenant, ASSET_NAME],
  );
  if (existing.rowCount) {
    console.log(`[seed:yield] already seeded: ${existing.rows.map((r) => `${r.period_start} ${r.status}`).join(", ")}`);
    return;
  }

  // People: the owner (dev-user, approver), a preparer (manager) and an auditor (verifier). Four-eyes needs two.
  const users = { owner: "dev-user", preparer: "dev-yield-preparer", auditor: "dev-yield-auditor" } as const;
  const ids: Record<string, string> = {};
  for (const [k, sub] of Object.entries(users)) ids[k] = (await upsertUserBySubject(pool, { issuer: "dev", subject: sub, name: sub })).id;
  await pool.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'verifier') ON CONFLICT DO NOTHING`, [tenant, ids.preparer, ids.auditor]);
  const token = async (k: keyof typeof users) => `Bearer ${await mintDevToken(secret!, users[k], users[k])}`;

  // Holders: A (payout address), B (none: withheld), D (tiny holding: deferred dust), and an unregistered wallet.
  const key = (b: number) => base58Encode(new Uint8Array(32).fill(b));
  const asset: ChainAssetRef = { network: "solana-devnet", rail: "SOLANA_TOKEN_2022", id: base58Encode(randomBytes(32)) };
  const [wA, wB, wD, stranger] = [key(101), key(102), key(104), key(103)];
  const { assetId, pa, pb, pd } = await withTenant(pool, tenant, async (tx) => {
    const farm = (await createFarm(tx, { name: "Yield simulation farm", timezone: "UTC", createdBy: ids.owner! })).id;
    const assetId = (await tx.query<{ id: string }>(`INSERT INTO business_assets (tenant_id, farm_id, kind, name) VALUES ($1, $2, 'farm_share', $3) RETURNING id`, [tx.tenantId, farm, ASSET_NAME])).rows[0]!.id;
    const pa = await createParty(tx, { kind: "person", displayName: "Simulation holder A", createdBy: ids.owner! });
    const pb = await createParty(tx, { kind: "organisation", displayName: "Simulation holder B", createdBy: ids.owner! });
    const pd = await createParty(tx, { kind: "person", displayName: "Simulation holder D", createdBy: ids.owner! });
    for (const [p, w] of [[pa, wA], [pb, wB], [pd, wD]] as const) await addWallet(tx, p, "solana-devnet", w);
    return { assetId, pa, pb, pd };
  });
  const ev = (to: string, amount: bigint, slot: bigint): OwnershipEvent => ({ asset, kind: "mint", from: null, to, amount, slot, txIndex: 0, ixIndex: 0, signature: base58Encode(randomBytes(64)) });
  await withSystem(pool, async (tx) => {
    await insertOwnershipEvents(tx, [ev(wA, 600n, 10n), ev(wB, 300n, 11n), ev(stranger, 100n, 12n), ev(wD, 1n, 13n)], "fixture");
    await advanceOwnershipCursor(tx, asset, 10_000n, "fixture");
  });

  const app = await buildApp({
    deps: { env, logger: createLogger({ service: "seed-yield", level: "warn" }), pool, jobs: createMemoryProducer(), storage: createMemoryStorage(), auth: createDevProvider(secret!), now: () => new Date(), yieldEngine: createPipelineYieldEngine() },
    docs: false,
  });
  const call = async (method: "POST" | "PATCH", path: string, who: keyof typeof users, payload: unknown = {}) => {
    const r = await app.inject({ method, url: `/v1/tenants/${tenant}/yield${path}`, headers: { authorization: await token(who) }, payload: payload as object });
    if (r.statusCode >= 300) throw new Error(`${method} ${path} → ${r.statusCode} ${r.body}`);
    return r.json();
  };
  try {
    const e1 = (await call("POST", "/evidence", "preparer", { contentSha256: h(1), evidenceType: "sales_invoice", classification: "confidential" })).id;
    const e2 = (await call("POST", "/evidence", "preparer", { contentSha256: h(2), evidenceType: "sales_invoice", classification: "confidential" })).id;
    const quarters: [string, string, bigint, bigint][] = [
      ["2026-01-01", "2026-03-31", 100n, 200n],
      ["2026-04-01", "2026-06-30", 200n, 300n],
      ["2026-07-01", "2026-09-30", 300n, 400n],
    ];
    for (const [i, [start, end, s0, s1]] of quarters.entries()) {
      const c = await call("POST", "/cycles", "preparer", { businessAssetId: assetId, periodStart: start, periodEnd: end, network: asset.network, rail: asset.rail, chainAssetId: asset.id });
      for (const [side, kind, amount, evId, ref] of [["revenue", "gross_revenue", "800000", e1, "INV-1"], ["expense", "operating_expense", "300000", e2, "EXP-1"]] as const)
        await call("POST", `/cycles/${c.id}/inputs`, "preparer", { side, kind, amount, currency: "USD", completeness: "known", evidenceId: evId, sourceKind: "invoice", sourceRef: ref });
      await call("PATCH", `/cycles/${c.id}`, "preparer", { entitlementRef: POLICY.entitlement.sha256, policyHash: await calculationPolicyHash(POLICY), formulaVersion: POLICY.formulaVersion, accountingCurrency: "USD", settlementMint: SETTLE, settlementDecimals: 6 });
      const base = dossierFor({ [pa]: "01".repeat(32), [pb]: null, [pd]: "04".repeat(32) });
      // A dust threshold above D's share defers D (carried to the next cycle).
      const dossier = { ...base, distributionPolicy: { ...base.distributionPolicy, dustThreshold: 10_000_000n } };
      await call("POST", `/cycles/${c.id}/simulation-dossier`, "preparer", JSON.parse(canonicalSimulationDossier(dossier)));
      await call("POST", `/cycles/${c.id}/lock`, "preparer", { reason: "period ended" });
      await call("PATCH", `/cycles/${c.id}`, "preparer", { slotStart: s0.toString(), slotEnd: s1.toString() });
      const calc = await call("POST", `/cycles/${c.id}/calculate`, "preparer");
      await call("POST", `/cycles/${c.id}/submit`, "preparer");
      await call("POST", `/cycles/${c.id}/attestations`, "auditor", { artifactSetId: calc.artifactSetId, attestedHash: calc.artifactSetHash, statement: "re-computed from the stored records" });
      if (i < 2) {
        await call("POST", `/cycles/${c.id}/approve`, "owner", { reason: "four-eyes review" });
        await call("POST", `/cycles/${c.id}/publish`, "owner");
        const batch = await call("POST", `/cycles/${c.id}/claim-intents`, "owner");
        console.log(`[seed:yield] ${start}: published, set ${calc.artifactSetHash.slice(0, 12)}…, ${batch.intentCount} unsigned intent(s)`);
      } else console.log(`[seed:yield] ${start}: calculated and under review (awaiting approval), set ${calc.artifactSetHash.slice(0, 12)}…`);
    }
  } finally {
    await app.close();
  }
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error("[seed:yield] failed:", e instanceof Error ? e.message : e);
    await pool.end();
    process.exit(1);
  });
