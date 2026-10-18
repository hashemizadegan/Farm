import type { FastifyInstance } from "fastify";
import { isSolanaAddress, isTronAddress, verifyIncomingTrc20 } from "@metafarm/chain";
import {
  addWallet,
  complianceView,
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
} from "@metafarm/db";
import {
  complianceDecision,
  createOrderSchema,
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
} from "@metafarm/domain";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/http";

const tenantParams = z.object({ tenantId: uuid });
const partyParams = tenantParams.extend({ partyId: uuid });
const orderParams = tenantParams.extend({ orderId: uuid });
const iso = (d: Date | null) => (d ? d.toISOString() : null);

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
    return app.inTenant(req, "rwa:read", async (tx) => ({ items: (await listParties(tx)).map(toParty) }));
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
    return app.inTenant(req, "rwa:read", async (tx) => ({ items: (await listOrders(tx)).map(toOrder) }));
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
}
