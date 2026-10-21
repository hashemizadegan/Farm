import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ClusterVerificationError, TOKEN_2022_PROGRAM, isSolanaAddress, isTronAddress, parseMintAccount, verifyIncomingTrc20 } from "@metafarm/chain";
import {
  addWallet,
  approveOrder,
  complianceView,
  createBusinessAsset,
  createRepresentation,
  getBusinessAsset,
  getRepresentation,
  linkMint,
  listBusinessAssets,
  listRepresentations,
  verifyBusinessAsset,
  type BusinessAssetRow,
  createOrder,
  createParty,
  findInboundPayment,
  getOrder,
  getParty,
  listCases,
  listOrderIntents,
  listOrders,
  listParties,
  listPartyWallets,
  listScreenings,
  orderForReconciliation,
  recordInboundPayment,
  recordScreening,
  setKyc,
  setOrderStatus,
  walletOfParty,
  type OrderRow,
  type PartyRow,
  type TenantTx,
  createCompressedRepresentation,
  createRegistrationOrder,
  getRegistration,
  listRegistrations,
  publicCnftMetadata,
  withSystem,
  type RegistrationRow,
} from "@metafarm/db";
import {
  complianceDecision,
  createAssetSchema,
  createOrderSchema,
  createRepresentationSchema,
  linkMintSchema,
  createPartySchema,
  kycSchema,
  networkAllowed,
  paymentSchema,
  railOf,
  reconcileOrder,
  screeningSchema,
  uuid,
  walletSchema,
  type Network,
  ASSET_COMMITMENT_SCHEME,
  CNFT_ASSET_KINDS,
  cnftMetadataFor,
  commitmentPreimage,
  createRegistrationSchema,
  type AssetKind,
} from "@metafarm/domain";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";
import { InvalidCursorError, toPage, type PageRequest } from "@metafarm/db";

const tenantParams = z.object({ tenantId: uuid });
/** List pages: `cursor` is the `nextCursor` of the previous page (the id of its last item). */
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(100), cursor: uuid.optional() }).strict();

/** One page of a list, newest-first or by name as the repository orders it. An unknown cursor is a 400. */
async function pageOf<T extends { id: string }, R>(query: unknown, load: (page: PageRequest) => Promise<T[]>, map: (rows: T[]) => R[] | Promise<R[]>): Promise<{ items: R[]; nextCursor: string | null }> {
  const q = parse(listQuery, query);
  let rows: T[];
  try {
    rows = await load({ limit: q.limit, after: q.cursor });
  } catch (e) {
    if (e instanceof InvalidCursorError) throw new HttpError(400, "invalid_cursor", "the cursor does not name an item of this list");
    throw e;
  }
  const page = toPage(rows, q.limit);
  return { items: await map(page.rows), nextCursor: page.nextCursor };
}
const partyParams = tenantParams.extend({ partyId: uuid });
const orderParams = tenantParams.extend({ orderId: uuid });
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const assetParams = tenantParams.extend({ assetId: uuid });
const representationParams = tenantParams.extend({ representationId: uuid });
const registrationParams = tenantParams.extend({ registrationId: uuid });

const toRegistration = (r: RegistrationRow) => ({
  id: r.id,
  reconciliationId: r.reconciliation_id,
  status: r.status,
  asset: { id: r.asset_id, name: r.asset_name, kind: r.asset_kind },
  custodian: { partyId: r.party_id, name: r.party_name, solanaWallet: r.custodian_address },
  network: r.network,
  leaf: {
    representationId: r.representation_id,
    status: r.representation_status,
    tree: r.tree_address,
    leafIndex: r.leaf_index,
    assetId: r.das_asset_id,
    leafHash: r.leaf_hash,
    metadataUri: r.metadata_uri,
  },
  approvedAt: iso(r.approved_at),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const toParty = (p: PartyRow) => ({
  id: p.id,
  kind: p.kind,
  displayName: p.display_name,
  jurisdiction: p.jurisdiction,
  kyc: { status: p.kyc_status, reference: p.kyc_reference, verifiedAt: iso(p.kyc_verified_at), expiresAt: iso(p.kyc_expires_at) },
  createdAt: p.created_at.toISOString(),
});

const toOrder = (o: OrderRow) => ({
  id: o.id,
  reconciliationId: o.reconciliation_id,
  kind: o.kind,
  partyId: o.party_id,
  partyName: o.party_name,
  representationId: o.representation_id,
  shareAmount: o.share_amount,
  settlementNetwork: o.settlement_network,
  tokenContract: o.token_contract,
  settlementAmount: o.settlement_amount,
  tronWallet: o.investor_tron_address,
  solanaWallet: o.investor_solana_address,
  status: o.status,
  approvedAt: iso(o.approved_at),
  createdAt: o.created_at.toISOString(),
  updatedAt: o.updated_at.toISOString(),
});

function validAddress(network: Network, address: string): boolean {
  return railOf(network) === "solana" ? isSolanaAddress(address) : isTronAddress(address);
}

/**
 * Real-world asset rails: investors, their wallets, compliance (KYC and sanctions screenings
 * from real providers), and orders. Mainnets stay closed unless RWA_MAINNET_ENABLED.
 */
export async function rwaRoutes(app: FastifyInstance) {
  const { env } = app.deps;
  const policy = { screeningMaxAgeDays: env.RWA_SCREENING_MAX_AGE_DAYS, blockedJurisdictions: env.RWA_BLOCKED_JURISDICTIONS };
  const checkNetwork = (network: Network) => {
    if (!networkAllowed(network, { mainnetEnabled: env.RWA_MAINNET_ENABLED })) throw new HttpError(403, "network_not_enabled", `${network} is not enabled for this platform`);
  };

  async function gate(tx: TenantTx, partyId: string, wallets: { network: Network; address: string }[]) {
    const view = await complianceView(tx, partyId, wallets);
    if (!view) throw notFound("party");
    const decision = complianceDecision(view.party, view.wallets, policy, app.deps.now());
    if (!decision.allowed) throw new HttpError(422, "compliance_blocked", "the investor or a wallet does not pass the compliance checks", decision.reasons);
    return decision;
  }

  const orderWallets = (o: { kind: string; settlementNetwork: Network; tronWallet: string | null; solanaWallet: string | null; representationNetwork?: Network | null }) => [
    ...(o.tronWallet ? [{ network: o.settlementNetwork, address: o.tronWallet }] : []),
    ...(o.solanaWallet && o.representationNetwork ? [{ network: o.representationNetwork, address: o.solanaWallet }] : []),
  ];

  async function partyDetail(tx: TenantTx, partyId: string) {
    const p = await getParty(tx, partyId);
    if (!p) throw notFound("party");
    const wallets = await listPartyWallets(tx, partyId);
    const view = (await complianceView(tx, partyId, wallets.map((w) => ({ network: w.network, address: w.address }))))!;
    return {
      ...toParty(p),
      wallets: wallets.map((w) => ({ id: w.id, network: w.network, address: w.address, screening: w.outcome ? { outcome: w.outcome, checkedAt: iso(w.checked_at) } : null })),
      screenings: (await listScreenings(tx, partyId)).map((s) => ({
        id: s.id,
        subject: s.subject,
        walletId: s.wallet_id,
        provider: s.provider,
        providerReference: s.provider_reference,
        outcome: s.outcome,
        reasons: s.reasons,
        checkedAt: s.checked_at.toISOString(),
      })),
      compliance: complianceDecision(view.party, view.wallets, policy, app.deps.now()),
    };
  }

  // ── Parties ──────────────────────────────────────────────────────────

  app.get("/v1/tenants/:tenantId/rwa/parties", async (req) => {
    parse(tenantParams, req.params);
    return app.inTenant(req, "rwa:read", (tx) => pageOf(req.query, (p) => listParties(tx, p), (rows) => rows.map(toParty)));
  });

  app.post("/v1/tenants/:tenantId/rwa/parties", async (req, reply) => {
    parse(tenantParams, req.params);
    const body = parse(createPartySchema, req.body);
    const out = await app.inTenant(req, "rwa:operate", async (tx) => {
      const id = await createParty(tx, { kind: body.kind, displayName: body.displayName, jurisdiction: body.jurisdiction ?? null, createdBy: req.user!.id });
      await app.audit(req, tx, { action: "rwa.party_created", targetType: "party", targetId: id });
      return partyDetail(tx, id);
    });
    return reply.status(201).send(out);
  });

  app.get("/v1/tenants/:tenantId/rwa/parties/:partyId", async (req) => {
    const { partyId } = parse(partyParams, req.params);
    return app.inTenant(req, "rwa:read", (tx) => partyDetail(tx, partyId));
  });

  app.post("/v1/tenants/:tenantId/rwa/parties/:partyId/kyc", async (req) => {
    const { partyId } = parse(partyParams, req.params);
    const body = parse(kycSchema, req.body);
    return app.inTenant(req, "compliance:review", async (tx) => {
      if (!(await getParty(tx, partyId))) throw notFound("party");
      await setKyc(tx, partyId, { status: body.status, reference: body.reference ?? null, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, verifiedBy: req.user!.id });
      await app.audit(req, tx, { action: "rwa.kyc_recorded", targetType: "party", targetId: partyId, metadata: { status: body.status, reference: body.reference ?? null } });
      return partyDetail(tx, partyId);
    });
  });

  app.post("/v1/tenants/:tenantId/rwa/parties/:partyId/wallets", async (req, reply) => {
    const { partyId } = parse(partyParams, req.params);
    const body = parse(walletSchema, req.body);
    if (!validAddress(body.network, body.address)) throw new HttpError(400, "invalid_address", `not a valid ${railOf(body.network) === "solana" ? "Solana" : "TRON"} address`);
    const out = await app.inTenant(req, "rwa:operate", async (tx) => {
      if (!(await getParty(tx, partyId))) throw notFound("party");
      try {
        await tx.query("SAVEPOINT wallet");
        await addWallet(tx, partyId, body.network, body.address);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new HttpError(409, "wallet_taken", "this address is already registered");
        throw err;
      }
      await app.audit(req, tx, { action: "rwa.wallet_added", targetType: "party", targetId: partyId, metadata: { network: body.network, address: body.address } });
      return partyDetail(tx, partyId);
    });
    return reply.status(201).send(out);
  });

  app.post("/v1/tenants/:tenantId/rwa/parties/:partyId/screenings", async (req, reply) => {
    const { partyId } = parse(partyParams, req.params);
    const body = parse(screeningSchema, req.body);
    const out = await app.inTenant(req, "compliance:review", async (tx) => {
      if (!(await getParty(tx, partyId))) throw notFound("party");
      if (body.walletId && !(await walletOfParty(tx, partyId, body.walletId))) throw notFound("wallet");
      const subject = body.walletId ? ({ subject: "wallet", walletId: body.walletId } as const) : ({ subject: "party", partyId } as const);
      await recordScreening(tx, subject, {
        provider: body.provider,
        providerReference: body.providerReference,
        outcome: body.outcome,
        reasons: body.reasons,
        checkedAt: new Date(body.checkedAt),
        recordedBy: req.user!.id,
      });
      await app.audit(req, tx, { action: "rwa.screening_recorded", targetType: "party", targetId: partyId, metadata: { subject: subject.subject, outcome: body.outcome, provider: body.provider } });
      return partyDetail(tx, partyId);
    });
    return reply.status(201).send(out);
  });

  // ── Orders ───────────────────────────────────────────────────────────

  async function orderDetail(tx: TenantTx, orderId: string) {
    const o = await getOrder(tx, orderId);
    if (!o) throw notFound("order");
    const intents = await listOrderIntents(tx, o.reconciliation_id);
    const view = (await orderForReconciliation(tx, orderId))!;
    return {
      ...toOrder(o),
      issuance: intents.issuance.map((i) => ({ id: i.id, action: i.action, amount: i.amount, holder: i.holder_address, status: i.status, createdAt: i.created_at.toISOString() })),
      settlement: intents.settlement.map((i) => ({
        id: i.id,
        purpose: i.purpose,
        direction: i.direction,
        amount: i.amount,
        payer: i.payer_address,
        payee: i.payee_address,
        status: i.status,
        txId: i.observed_tx_ref,
        observedAmount: i.observed_amount,
        observedBlock: i.observed_block,
        observedAt: iso(i.observed_at),
        createdAt: i.created_at.toISOString(),
      })),
      cases: (await listCases(tx, o.reconciliation_id)).map((c) => ({
        id: c.id,
        kind: c.kind,
        status: c.status,
        expected: c.expected,
        observed: c.observed,
        openedAt: c.opened_at.toISOString(),
        resolvedAt: iso(c.resolved_at),
        resolutionNote: c.resolution_note,
      })),
      // What reconciliation would report right now (cases are opened by the scheduled sweep).
      discrepancies: reconcileOrder(view.order, view.intents, app.deps.now(), Number.MAX_SAFE_INTEGER).map((d) => d.kind),
    };
  }

  const representationNetwork = async (tx: TenantTx, id: string | null) => {
    if (!id) return null;
    const r = await tx.query<{ network: Network; rail: string; status: string }>(`SELECT network, rail, status FROM asset_representations WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id]);
    const row = r.rows[0];
    if (!row) throw notFound("share token");
    if (row.rail !== "SOLANA_TOKEN_2022") throw new HttpError(400, "invalid_representation", "orders trade fungible shares (Token-2022)");
    if (row.status === "frozen" || row.status === "retired") throw new HttpError(409, "representation_unavailable", `the share token is ${row.status}`);
    return row.network;
  };

  app.get("/v1/tenants/:tenantId/rwa/orders", async (req) => {
    parse(tenantParams, req.params);
    return app.inTenant(req, "rwa:read", (tx) => pageOf(req.query, (p) => listOrders(tx, p), (rows) => rows.map(toOrder)));
  });

  app.get("/v1/tenants/:tenantId/rwa/orders/:orderId", async (req) => {
    const { orderId } = parse(orderParams, req.params);
    return app.inTenant(req, "rwa:read", (tx) => orderDetail(tx, orderId));
  });

  app.post("/v1/tenants/:tenantId/rwa/orders", async (req, reply) => {
    parse(tenantParams, req.params);
    const body = parse(createOrderSchema, req.body);
    checkNetwork(body.settlementNetwork);
    if (!isTronAddress(body.tokenContract) || !isTronAddress(body.tronWallet)) throw new HttpError(400, "invalid_address", "token contract and TRON wallet must be TRON addresses");
    if (body.solanaWallet && !isSolanaAddress(body.solanaWallet)) throw new HttpError(400, "invalid_address", "not a valid Solana address");
    const out = await app.inTenant(req, "rwa:operate", async (tx) => {
      const repNetwork = await representationNetwork(tx, body.representationId ?? null);
      if (repNetwork) checkNetwork(repNetwork);
      await gate(tx, body.partyId, orderWallets({ kind: body.kind, settlementNetwork: body.settlementNetwork, tronWallet: body.tronWallet, solanaWallet: body.solanaWallet ?? null, representationNetwork: repNetwork }));
      const o = await createOrder(tx, {
        kind: body.kind,
        partyId: body.partyId,
        representationId: body.representationId ?? null,
        shareAmount: body.shareAmount ? BigInt(body.shareAmount) : null,
        settlementNetwork: body.settlementNetwork,
        tokenContract: body.tokenContract,
        settlementAmount: BigInt(body.settlementAmount),
        investorTronAddress: body.tronWallet,
        investorSolanaAddress: body.solanaWallet ?? null,
        createdBy: req.user!.id,
      });
      await app.audit(req, tx, { action: "rwa.order_created", targetType: "rwa_order", targetId: o.id, metadata: { kind: body.kind, partyId: body.partyId } });
      return orderDetail(tx, o.id);
    });
    return reply.status(201).send(out);
  });

  app.post("/v1/tenants/:tenantId/rwa/orders/:orderId/cancel", async (req) => {
    const { orderId } = parse(orderParams, req.params);
    return app.inTenant(req, "rwa:operate", async (tx) => {
      const o = await getOrder(tx, orderId, true);
      if (!o) throw notFound("order");
      if (o.status !== "open") throw new HttpError(409, "order_in_progress", "only an order with nothing done yet can be cancelled");
      await setOrderStatus(tx, orderId, "cancelled");
      await app.audit(req, tx, { action: "rwa.order_cancelled", targetType: "rwa_order", targetId: orderId });
      return orderDetail(tx, orderId);
    });
  });

  /**
   * A second person approves a redemption or distribution: only then may the platform burn shares
   * or pay out of the treasury. Compliance is checked again at approval and again at signing.
   */
  app.post("/v1/tenants/:tenantId/rwa/orders/:orderId/approve", async (req) => {
    const { orderId } = parse(orderParams, req.params);
    return app.inTenant(req, "rwa:operate", async (tx) => {
      const o = await getOrder(tx, orderId, true);
      if (!o) throw notFound("order");
      if (o.kind === "subscription") throw new HttpError(409, "not_approvable", "subscriptions start when the investor's payment is verified");
      if (o.status !== "open") throw new HttpError(409, "order_not_open", `the order is ${o.status}`);
      if (o.created_by === req.user!.id) throw new HttpError(403, "four_eyes", "someone other than the person who placed the order must approve it");
      checkNetwork(o.settlement_network);
      const repNetwork = await representationNetwork(tx, o.representation_id);
      if (repNetwork) checkNetwork(repNetwork);
      await gate(tx, o.party_id, orderWallets({ kind: o.kind, settlementNetwork: o.settlement_network, tronWallet: o.investor_tron_address, solanaWallet: o.investor_solana_address, representationNetwork: repNetwork }));
      await approveOrder(tx, orderId, req.user!.id, o.kind === "redemption" ? "issuing" : "settling");
      await app.audit(req, tx, { action: "rwa.order_approved", targetType: "rwa_order", targetId: orderId, metadata: { kind: o.kind } });
      return orderDetail(tx, orderId);
    });
  });

  /** Records an investor's subscription payment after verifying it on the solidified TRON chain. */
  app.post("/v1/tenants/:tenantId/rwa/orders/:orderId/payments", async (req) => {
    const { orderId } = parse(orderParams, req.params);
    const { txId } = parse(paymentSchema, req.body);
    const id = txId.toLowerCase();
    const { tron } = app.deps;
    const treasury = env.RWA_TRON_TREASURY;
    if (!tron || !treasury) throw new HttpError(503, "payments_not_configured", "TRON payment checks are not configured on this platform");

    // 1. Read the order (and refuse early) without holding a transaction during the chain lookup.
    const order = await app.inTenant(req, "rwa:operate", async (tx) => {
      const o = await getOrder(tx, orderId);
      if (!o) throw notFound("order");
      const seen = await findInboundPayment(tx, o.settlement_network, id);
      if (seen && seen.reconciliation_id !== o.reconciliation_id) throw new HttpError(409, "payment_used", "this payment is already recorded for another order");
      return { o, already: Boolean(seen) };
    });
    if (order.already) return app.inTenant(req, "rwa:read", (tx) => orderDetail(tx, orderId));
    const o = order.o;
    if (o.kind !== "subscription") throw new HttpError(409, "not_a_subscription", "only subscriptions are paid by the investor");
    if (o.status !== "open") throw new HttpError(409, "order_not_open", `the order is ${o.status}`);
    checkNetwork(o.settlement_network);

    // 2. The chain must show exactly this payment.
    const check = await verifyIncomingTrc20(tron, id, { tokenContract: o.token_contract, from: o.investor_tron_address!, to: treasury, amount: BigInt(o.settlement_amount) });
    if (!check.ok) throw new HttpError(422, "payment_not_verified", `the payment could not be verified: ${check.reason}`, { reason: check.reason, detail: check.detail ?? null });

    // 3. Record it, re-checking the order and compliance under lock.
    return app.inTenant(req, "rwa:operate", async (tx) => {
      const locked = await getOrder(tx, orderId, true);
      if (!locked || locked.status !== "open") throw new HttpError(409, "order_not_open", "the order changed meanwhile");
      const repNetwork = await representationNetwork(tx, locked.representation_id);
      await gate(tx, locked.party_id, orderWallets({ kind: locked.kind, settlementNetwork: locked.settlement_network, tronWallet: locked.investor_tron_address, solanaWallet: locked.investor_solana_address, representationNetwork: repNetwork }));
      try {
        await tx.query("SAVEPOINT payment");
        await recordInboundPayment(tx, {
          reconciliationId: locked.reconciliation_id,
          partyId: locked.party_id,
          network: locked.settlement_network,
          tokenContract: locked.token_contract,
          payer: locked.investor_tron_address!,
          payee: treasury,
          expectedAmount: BigInt(locked.settlement_amount),
          txRef: id,
          observedAmount: check.amount,
          block: check.block,
          observedAt: check.timestamp,
          requestedBy: req.user!.id,
        });
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new HttpError(409, "payment_used", "this payment is already recorded");
        throw err;
      }
      await setOrderStatus(tx, orderId, "issuing");
      await app.audit(req, tx, { action: "rwa.payment_recorded", targetType: "rwa_order", targetId: orderId, metadata: { txId: id, block: check.block.toString() } });
      return orderDetail(tx, orderId);
    });
  });

  // ── Assets and share tokens ─────────────────────────────────────────

  async function assetDetail(tx: TenantTx, a: BusinessAssetRow) {
    return {
      id: a.id,
      farmId: a.farm_id,
      farmName: a.farm_name,
      kind: a.kind,
      name: a.name,
      externalRef: a.external_ref,
      parcelLabel: a.parcel_label,
      geometry: a.geometry,
      geomProvenance: a.geom_provenance,
      status: a.status,
      verifiedAt: iso(a.verified_at),
      createdAt: a.created_at.toISOString(),
      representations: (await listRepresentations(tx, a.id)).map((r) => ({
        id: r.id,
        rail: r.rail,
        network: r.network,
        status: r.status,
        mintAddress: r.mint_address,
        decimals: r.decimals,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  app.get("/v1/tenants/:tenantId/rwa/assets", async (req) => {
    parse(tenantParams, req.params);
    return app.inTenant(req, "rwa:read", (tx) => pageOf(req.query, (p) => listBusinessAssets(tx, p), (rows) => Promise.all(rows.map((a) => assetDetail(tx, a)))));
  });

  app.post("/v1/tenants/:tenantId/rwa/assets", async (req, reply) => {
    parse(tenantParams, req.params);
    const body = parse(createAssetSchema, req.body);
    const out = await app.inTenant(req, "rwa:operate", async (tx) => {
      const farm = await tx.query(`SELECT 1 FROM farms WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`, [tx.tenantId, body.farmId]);
      if (!farm.rowCount) throw notFound("farm");
      let id: string;
      try {
        await tx.query("SAVEPOINT asset");
        id = await createBusinessAsset(tx, { ...body, createdBy: req.user!.id });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "23505") throw new HttpError(409, "asset_ref_taken", "an asset of this kind already has this reference");
        if (code === "23514" || code === "XX000") throw new HttpError(400, "invalid_geometry", "the geometry is not valid");
        throw err;
      }
      await app.audit(req, tx, { action: "rwa.asset_created", targetType: "business_asset", targetId: id, metadata: { kind: body.kind } });
      return assetDetail(tx, (await getBusinessAsset(tx, id))!);
    });
    return reply.status(201).send(out);
  });

  /** A second person confirms the asset exists as described (four eyes); spatial assets must lie on the farm. */
  app.post("/v1/tenants/:tenantId/rwa/assets/:assetId/verify", async (req) => {
    const { assetId } = parse(assetParams, req.params);
    return app.inTenant(req, "compliance:review", async (tx) => {
      const a = await getBusinessAsset(tx, assetId);
      if (!a) throw notFound("asset");
      if (a.status !== "draft") throw new HttpError(409, "asset_not_draft", `the asset is already ${a.status}`);
      if (a.created_by === req.user!.id) throw new HttpError(403, "four_eyes", "someone other than the person who registered the asset must verify it");
      if ((a.kind === "parcel" || a.kind === "tree") && !a.geometry) throw new HttpError(409, "geometry_required", "parcels and trees need surveyed geometry before verification");
      if (a.geometry) {
        const inside = await tx.query<{ ok: boolean | null }>(
          `SELECT CASE WHEN b.geom IS NULL THEN NULL ELSE ST_CoveredBy(x.geom, b.geom) END AS ok
             FROM business_assets x JOIN farms f ON f.tenant_id = x.tenant_id AND f.id = x.farm_id
             LEFT JOIN boundary_versions b ON b.tenant_id = f.tenant_id AND b.id = f.current_boundary_version_id
            WHERE x.tenant_id = $1 AND x.id = $2`,
          [tx.tenantId, assetId],
        );
        if (inside.rows[0]?.ok === false) throw new HttpError(409, "outside_farm", "the asset lies outside the farm's current boundary");
      }
      await verifyBusinessAsset(tx, assetId, req.user!.id);
      await app.audit(req, tx, { action: "rwa.asset_verified", targetType: "business_asset", targetId: assetId });
      return assetDetail(tx, (await getBusinessAsset(tx, assetId))!);
    });
  });

  app.post("/v1/tenants/:tenantId/rwa/assets/:assetId/representations", async (req, reply) => {
    const { assetId } = parse(assetParams, req.params);
    const body = parse(createRepresentationSchema, req.body);
    checkNetwork(body.network);
    const out = await app.inTenant(req, "rwa:operate", async (tx) => {
      const a = await getBusinessAsset(tx, assetId);
      if (!a) throw notFound("asset");
      if (a.status !== "verified" && a.status !== "active") throw new HttpError(409, "asset_not_verified", "verify the asset before issuing shares in it");
      try {
        await tx.query("SAVEPOINT rep");
        await createRepresentation(tx, assetId, body.network, body.decimals);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new HttpError(409, "representation_exists", "this asset already has a share token on that network");
        throw err;
      }
      await app.audit(req, tx, { action: "rwa.representation_created", targetType: "business_asset", targetId: assetId, metadata: { network: body.network } });
      return assetDetail(tx, a);
    });
    return reply.status(201).send(out);
  });

  /** Links an existing Token-2022 mint after reading it from the chain: our issuer must be its mint authority. */
  app.post("/v1/tenants/:tenantId/rwa/representations/:representationId/mint", async (req) => {
    const { representationId } = parse(representationParams, req.params);
    const { mintAddress } = parse(linkMintSchema, req.body);
    if (!isSolanaAddress(mintAddress)) throw new HttpError(400, "invalid_address", "not a Solana address");
    const { solanaRpc, solanaCluster } = app.deps;
    if (!solanaRpc || !solanaCluster || !env.RWA_SOLANA_ISSUER) throw new HttpError(503, "issuance_not_configured", "Solana issuance is not configured on this platform");
    const rep = await app.inTenant(req, "rwa:operate", async (tx) => {
      const r = await getRepresentation(tx, representationId);
      if (!r) throw notFound("share token");
      if (r.mint_address) throw new HttpError(409, "mint_linked", "a mint is already linked");
      if (r.network !== env.RWA_SOLANA_NETWORK) throw new HttpError(409, "wrong_network", `this platform issues on ${env.RWA_SOLANA_NETWORK}`);
      return r;
    });
    // The network setting is only a label: the RPC must prove it serves that cluster before a mint is read from it.
    try {
      await solanaCluster();
    } catch (err) {
      // Logged by scheme and host only; the response names neither, nor any credential.
      const e = err instanceof ClusterVerificationError ? { reason: err.reason, endpoint: err.endpoint } : { reason: "unexpected" };
      req.log.error(e, "Solana RPC cluster check failed; mint not linked");
      if (err instanceof ClusterVerificationError && err.reason !== "unavailable")
        throw new HttpError(422, "solana_cluster_mismatch", `the platform's Solana RPC does not serve ${env.RWA_SOLANA_NETWORK}; the mint was not checked or linked`);
      throw new HttpError(503, "solana_rpc_unavailable", "the platform's Solana RPC could not be verified; try again later");
    }
    const account = await solanaRpc.getAccountInfo(mintAddress);
    if (!account || account.owner !== TOKEN_2022_PROGRAM) throw new HttpError(422, "not_a_mint", "no Token-2022 mint at that address");
    const mint = parseMintAccount(account.data);
    if (!mint.initialized) throw new HttpError(422, "not_a_mint", "the mint is not initialised");
    if (mint.mintAuthority !== env.RWA_SOLANA_ISSUER) throw new HttpError(422, "not_our_mint", "the platform's issuer is not this mint's authority");
    if (rep.decimals !== null && rep.decimals !== mint.decimals) throw new HttpError(422, "decimals_mismatch", `the mint has ${mint.decimals} decimals, the share token ${rep.decimals}`);
    return app.inTenant(req, "rwa:operate", async (tx) => {
      try {
        await tx.query("SAVEPOINT link");
        await linkMint(tx, representationId, mintAddress, mint.decimals);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new HttpError(409, "mint_taken", "that mint is linked to another share token");
        throw err;
      }
      await app.audit(req, tx, { action: "rwa.mint_linked", targetType: "asset_representation", targetId: representationId, metadata: { mintAddress, supply: mint.supply.toString() } });
      return assetDetail(tx, (await getBusinessAsset(tx, rep.asset_id))!);
    });
  });

  // ── Registrations: one-of-a-kind assets as compressed NFTs held by a custodian ──

  /**
   * Records a verified parcel, tree or animal as a compressed NFT to be minted to a custodian's
   * screened Solana wallet. The leaf's metadata is fixed now: a name, a symbol and a URI pointing at
   * a public document that commits to the asset record by a salted hash (no coordinates on chain).
   */
  app.post("/v1/tenants/:tenantId/rwa/assets/:assetId/registrations", async (req, reply) => {
    const { assetId } = parse(assetParams, req.params);
    const body = parse(createRegistrationSchema, req.body);
    checkNetwork(body.network);
    if (!isSolanaAddress(body.solanaWallet)) throw new HttpError(400, "invalid_address", "not a Solana address");
    const base = env.RWA_CNFT_METADATA_BASE_URL;
    if (!base) throw new HttpError(503, "registrations_not_configured", "compressed NFT registrations are not configured on this platform");
    const out = await app.inTenant(req, "rwa:operate", async (tx) => {
      const a = await getBusinessAsset(tx, assetId);
      if (!a) throw notFound("asset");
      if (!(CNFT_ASSET_KINDS as readonly string[]).includes(a.kind)) throw new HttpError(409, "not_registrable", "only parcels, trees and livestock are registered as compressed NFTs");
      if (a.status !== "verified" && a.status !== "active") throw new HttpError(409, "asset_not_verified", "verify the asset before registering it");
      await gate(tx, body.partyId, [{ network: body.network, address: body.solanaWallet }]);
      const representationId = randomUUID();
      let metadata;
      try {
        metadata = cnftMetadataFor({ kind: a.kind as AssetKind, name: a.name }, base, representationId);
      } catch (err) {
        throw new HttpError(422, "invalid_metadata", (err as Error).message);
      }
      const salt = randomBytes(16).toString("hex");
      const preimage = commitmentPreimage(salt, {
        assetId: a.id,
        kind: a.kind as AssetKind,
        externalRef: a.external_ref,
        parcelLabel: a.parcel_label,
        geometry: a.geometry,
        geomProvenance: a.geom_provenance,
        verifiedAt: iso(a.verified_at),
      });
      const commitment = { algorithm: "sha256" as const, scheme: ASSET_COMMITMENT_SCHEME, hash: createHash("sha256").update(preimage).digest("hex") };
      let order: { id: string };
      try {
        await tx.query("SAVEPOINT registration");
        await createCompressedRepresentation(tx, { id: representationId, assetId, network: body.network, metadata: { ...metadata, commitment, commitmentSalt: salt } });
        order = await createRegistrationOrder(tx, { partyId: body.partyId, representationId, custodianSolanaAddress: body.solanaWallet, createdBy: req.user!.id });
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new HttpError(409, "already_registered", "this asset is already registered on that network");
        throw err;
      }
      await app.audit(req, tx, { action: "rwa.registration_created", targetType: "rwa_order", targetId: order.id, metadata: { assetId, network: body.network } });
      return toRegistration((await getRegistration(tx, order.id))!);
    });
    return reply.status(201).send(out);
  });

  app.get("/v1/tenants/:tenantId/rwa/registrations", async (req) => {
    parse(tenantParams, req.params);
    return app.inTenant(req, "rwa:read", (tx) => pageOf(req.query, (p) => listRegistrations(tx, p), (rows) => rows.map(toRegistration)));
  });

  app.get("/v1/tenants/:tenantId/rwa/registrations/:registrationId", async (req) => {
    const { registrationId } = parse(registrationParams, req.params);
    return app.inTenant(req, "rwa:read", async (tx) => {
      const r = await getRegistration(tx, registrationId);
      if (!r) throw notFound("registration");
      return {
        ...toRegistration(r),
        cases: (await listCases(tx, r.reconciliation_id)).map((c) => ({
          id: c.id,
          kind: c.kind,
          status: c.status,
          expected: c.expected,
          observed: c.observed,
          openedAt: c.opened_at.toISOString(),
          resolvedAt: iso(c.resolved_at),
          resolutionNote: c.resolution_note,
        })),
      };
    });
  });

  /** A second person approves the mint (four eyes); the custodian must still pass compliance. */
  app.post("/v1/tenants/:tenantId/rwa/registrations/:registrationId/approve", async (req) => {
    const { registrationId } = parse(registrationParams, req.params);
    return app.inTenant(req, "rwa:operate", async (tx) => {
      const r = await getRegistration(tx, registrationId, true);
      if (!r) throw notFound("registration");
      if (r.status !== "open") throw new HttpError(409, "registration_not_open", `the registration is ${r.status}`);
      if (r.created_by === req.user!.id) throw new HttpError(403, "four_eyes", "someone other than the person who registered the asset must approve its mint");
      checkNetwork(r.network);
      await gate(tx, r.party_id, [{ network: r.network, address: r.custodian_address }]);
      await approveOrder(tx, registrationId, req.user!.id, "issuing");
      await app.audit(req, tx, { action: "rwa.registration_approved", targetType: "rwa_order", targetId: registrationId });
      return toRegistration((await getRegistration(tx, registrationId))!);
    });
  });

  // ── Public metadata of a compressed NFT (no sign-in): what its on-chain URI points at. ──
  app.get(
    "/v1/public/rwa/cnft/:representationId",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { representationId } = parse(z.object({ representationId: uuid }), req.params);
      const m = await withSystem(app.deps.pool, (tx) => publicCnftMetadata(tx, representationId));
      if (!m) throw notFound("compressed NFT");
      reply.header("cache-control", "public, max-age=300");
      return {
        name: m.name,
        symbol: m.symbol,
        description: "A one-of-a-kind farm asset. The commitment is a salted SHA-256 of the canonical asset record, disclosed by the operator on request.",
        attributes: [
          { trait_type: "asset_kind", value: m.kind },
          { trait_type: "commitment", value: `${m.commitment.algorithm}:${m.commitment.hash}` },
        ],
        properties: { network: m.network, status: m.status, assetId: m.das_asset_id, commitment: m.commitment },
      };
    },
  );
}
