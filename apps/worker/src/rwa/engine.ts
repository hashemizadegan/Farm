/**
 * Carries out the legs we sign. Each tick: start issuance for paid subscriptions, give every live
 * intent an attempt, and move every unfinished attempt one step along its lifecycle
 * (requested → policy_approved → prepared → submitted → observed → confirmed → business_completed).
 *
 * Crash-safe by construction: the signed transaction is stored before it is sent, it is only ever
 * re-sent byte for byte, and a new attempt is made only after the previous one provably expired.
 * Network and signing calls happen outside database transactions; each result is written under a
 * row lock after checking the attempt is still where it was.
 */
import {
  complianceView,
  createIssuanceIntent,
  createOperation,
  createSettlementIntent,
  getOperation,
  getOrder,
  getRepresentation,
  intentsToDrive,
  issuanceContext,
  latestOperation,
  moveOperation,
  operationsToDrive,
  orderForReconciliation,
  ordersToAdvance,
  setIntentStatus,
  setOrderStatus,
  settlementContext,
  withSystem,
  withTenant,
  type OperationRow,
  type Pool,
  type TenantTx,
} from "@metafarm/db";
import {
  ORDER_LEGS,
  complianceDecision,
  firstLegMayStart,
  legNeedsAttention,
  networkAllowed,
  railOf,
  secondLegMayStart,
  stepsAfterObservation,
  type AssetIssuancePort,
  type ChainObservationPort,
  type CompliancePolicy,
  type Network,
  type PreparedTransaction,
  type SettlementPort,
} from "@metafarm/domain";

export interface Rails {
  solana?: { network: Network; issuance: AssetIssuancePort; observer: ChainObservationPort };
  /** Payouts leave from the treasury, which is the TRON signer. */
  tron?: { network: Network; settlement: SettlementPort; observer: ChainObservationPort; treasury: string };
}

export interface EngineDeps {
  pool: Pool;
  rails: Rails;
  policy: CompliancePolicy;
  mainnetEnabled: boolean;
  now: () => Date;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export interface TickSummary {
  started: number;
  attempts: number;
  moves: number;
}

export async function runTick(d: EngineDeps): Promise<TickSummary> {
  const started = await advanceOrders(d);
  const attempts = await driveIntents(d);
  const moves = await driveOperations(d);
  return { started, attempts, moves };
}

/**
 * Starts the next leg of each order in play: a paid subscription's mint; an approved redemption's
 * burn, then its payout; an approved distribution's payout. A leg that ended without completing
 * stops the order for a person to look at.
 */
async function advanceOrders(d: EngineDeps): Promise<number> {
  let n = 0;
  for (const o of await withSystem(d.pool, (tx) => ordersToAdvance(tx))) {
    n += await withTenant(d.pool, o.tenant_id, async (tx) => {
      const order = await getOrder(tx, o.id, true);
      if (!order || (order.status !== "issuing" && order.status !== "settling")) return 0;
      const view = await orderForReconciliation(tx, o.id);
      if (!view) return 0;
      if (legNeedsAttention(view.order, view.intents)) {
        await setOrderStatus(tx, o.id, "exception");
        return 0;
      }
      const legs = ORDER_LEGS[order.kind];
      const leg = firstLegMayStart(view.order, view.intents) ? legs.first : secondLegMayStart(view.order, view.intents) ? legs.second : null;
      if (!leg) return 0;

      if (leg.side === "issuance") {
        const solana = d.rails.solana;
        if (!solana || !order.representation_id || !order.investor_solana_address || !order.share_amount) return 0;
        const rep = await getRepresentation(tx, order.representation_id);
        if (!rep?.mint_address || rep.network !== solana.network) return 0;
        await createIssuanceIntent(tx, {
          representationId: rep.id,
          action: leg.action,
          amount: BigInt(order.share_amount),
          holder: order.investor_solana_address,
          reconciliationId: order.reconciliation_id,
          partyId: order.party_id,
          decision: { reason: order.kind === "subscription" ? "subscription payment verified on chain" : "approved by a second person" },
        });
        if (order.status !== "issuing") await setOrderStatus(tx, o.id, "issuing");
        return 1;
      }
      // Investors pay subscriptions themselves; the engine only pays out.
      if (leg.purpose === "subscription") return 0;
      const tron = d.rails.tron;
      if (!tron || tron.network !== order.settlement_network || !order.investor_tron_address) return 0;
      await createSettlementIntent(tx, {
        network: order.settlement_network,
        tokenContract: order.token_contract,
        purpose: leg.purpose === "redemption" ? "redemption" : "distribution",
        payer: tron.treasury,
        payee: order.investor_tron_address,
        amount: BigInt(order.settlement_amount),
        reconciliationId: order.reconciliation_id,
        partyId: order.party_id,
        decision: { reason: "approved by a second person" },
      });
      if (order.status !== "settling") await setOrderStatus(tx, o.id, "settling");
      return 1;
    });
  }
  return n;
}

/** Every live intent has exactly one live attempt; finished attempts settle the intent. */
async function driveIntents(d: EngineDeps): Promise<number> {
  let n = 0;
  for (const i of await withSystem(d.pool, (tx) => intentsToDrive(tx))) {
    n += await withTenant(d.pool, i.tenant_id, async (tx) => {
      const last = await latestOperation(tx, i.type, i.id);
      const settled = { business_completed: "completed", failed: "failed", policy_rejected: "policy_rejected" } as const;
      if (last && last.state in settled) {
        await setIntentStatus(tx, i.type, i.id, settled[last.state as keyof typeof settled]);
        return 0;
      }
      if (last && last.state !== "expired") return 0;
      const network = await intentNetwork(tx, i.type, i.id);
      if (!network) return 0;
      await createOperation(tx, i.type, i.id, (last?.attempt ?? 0) + 1, network);
      await setIntentStatus(tx, i.type, i.id, "in_progress");
      return 1;
    });
  }
  return n;
}

async function intentNetwork(tx: TenantTx, type: "issuance" | "settlement", id: string): Promise<Network | undefined> {
  if (type === "issuance") return (await issuanceContext(tx, id))?.network;
  return (await tx.query<{ network: Network }>(`SELECT network FROM settlement_intents WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, id])).rows[0]?.network;
}

function observerFor(d: EngineDeps, network: Network): ChainObservationPort | undefined {
  if (railOf(network) === "solana") return d.rails.solana?.network === network ? d.rails.solana.observer : undefined;
  return d.rails.tron?.network === network ? d.rails.tron.observer : undefined;
}

/** What an attempt needs to know about its intent, whichever rail it is on. */
interface Work {
  partyId: string | null;
  /** The investor's wallet the transaction pays or credits (checked by the gate). */
  wallet: { network: Network; address: string };
  prepare: () => Promise<PreparedTransaction> | undefined;
}

async function workFor(d: EngineDeps, tx: TenantTx, op: OperationRow): Promise<Work | undefined> {
  if (op.intent_type === "issuance") {
    const c = await issuanceContext(tx, op.intent_id);
    if (!c) return undefined;
    const solana = d.rails.solana;
    return {
      partyId: c.party_id,
      wallet: { network: c.network, address: c.holder_address },
      prepare: () =>
        solana && solana.network === op.network && c.mint_address && c.decimals !== null
          ? solana.issuance.prepareIssuance({
              network: op.network,
              action: c.action,
              mintAddress: c.mint_address,
              decimals: c.decimals,
              holderAddress: c.holder_address,
              ...(c.amount ? { amount: BigInt(c.amount) } : {}),
            })
          : undefined,
    };
  }
  const c = await settlementContext(tx, op.intent_id);
  if (!c) return undefined;
  const tron = d.rails.tron;
  return {
    partyId: c.party_id,
    wallet: { network: c.network, address: c.payee_address },
    prepare: () =>
      tron && tron.network === op.network && c.payer_address === tron.treasury
        ? tron.settlement.prepareTransfer({ network: op.network, tokenContract: c.token_contract, from: c.payer_address, to: c.payee_address, amount: BigInt(c.amount) })
        : undefined,
  };
}

function preparedFrom(op: OperationRow): PreparedTransaction {
  return {
    network: op.network,
    txRef: op.tx_ref!,
    wire: op.signed_wire!,
    validity: { ...(op.last_valid_block_height ? { lastValidBlockHeight: BigInt(op.last_valid_block_height) } : {}), ...(op.expires_at ? { expiresAt: op.expires_at } : {}) },
    fees: {},
    summary: {},
  };
}

/** Writes a step if the attempt is still in the state we acted on. */
async function step(d: EngineDeps, tenantId: string, op: OperationRow, apply: (tx: TenantTx) => Promise<void>): Promise<boolean> {
  return withTenant(d.pool, tenantId, async (tx) => {
    const now = await getOperation(tx, op.id, true);
    if (!now || now.state !== op.state) return false;
    await apply(tx);
    return true;
  });
}

async function driveOperations(d: EngineDeps): Promise<number> {
  let moves = 0;
  for (const ref of await withSystem(d.pool, (tx) => operationsToDrive(tx))) {
    try {
      moves += await driveOne(d, ref.tenant_id, ref.id);
    } catch (err) {
      // One stuck attempt must not hold up the others; it is tried again next tick.
      d.log.warn({ operationId: ref.id, err: (err as Error).message }, "RWA operation step failed");
    }
  }
  return moves;
}

async function driveOne(d: EngineDeps, tenantId: string, id: string): Promise<number> {
  const loaded = await withTenant(d.pool, tenantId, async (tx) => {
    const op = await getOperation(tx, id);
    return op ? { op, work: await workFor(d, tx, op) } : undefined;
  });
  if (!loaded?.work) return 0;
  const { op, work } = loaded;
  const table = op.intent_type === "issuance" ? "issuance_intents" : "settlement_intents";

  switch (op.state) {
    case "requested": {
      // Compliance and network gates, decided now (KYC or screenings may have changed since the order).
      const verdict = await withTenant(d.pool, tenantId, async (tx) => {
        if (!networkAllowed(op.network, { mainnetEnabled: d.mainnetEnabled })) return { allowed: false, reasons: ["network_not_enabled"] };
        if (!work.partyId) return { allowed: false, reasons: ["no_party"] };
        const view = await complianceView(tx, work.partyId, [work.wallet]);
        return view ? complianceDecision(view.party, view.wallets, d.policy, d.now()) : { allowed: false, reasons: ["no_party"] };
      });
      const ok = await step(d, tenantId, op, async (tx) => {
        await tx.query(`UPDATE ${table} SET policy_decision = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [
          tx.tenantId,
          op.intent_id,
          JSON.stringify({ ...verdict, at: d.now().toISOString() }),
        ]);
        await moveOperation(tx, op.id, verdict.allowed ? "policy_approved" : "policy_rejected", verdict.allowed ? {} : { error: verdict.reasons.join(", ") });
      });
      return ok ? 1 : 0;
    }
    case "policy_approved": {
      const pending = work.prepare();
      if (!pending) return 0;
      const prepared = await pending;
      const ok = await step(d, tenantId, op, (tx) =>
        moveOperation(tx, op.id, "prepared", {
          txRef: prepared.txRef,
          signedWire: prepared.wire,
          ...(prepared.validity.lastValidBlockHeight !== undefined ? { lastValidBlockHeight: prepared.validity.lastValidBlockHeight } : {}),
          ...(prepared.validity.expiresAt ? { expiresAt: prepared.validity.expiresAt } : {}),
          ...(prepared.fees.priorityFeeMicroLamports !== undefined ? { priorityFee: prepared.fees.priorityFeeMicroLamports } : {}),
          ...(prepared.fees.feeLimitSun !== undefined ? { feeLimitSun: prepared.fees.feeLimitSun } : {}),
          ...(prepared.fees.estimatedEnergy !== undefined ? { estimatedEnergy: prepared.fees.estimatedEnergy } : {}),
          ...(prepared.fees.estimatedBandwidth !== undefined ? { estimatedBandwidth: prepared.fees.estimatedBandwidth } : {}),
          summary: prepared.summary,
        }),
      );
      return ok ? 1 : 0;
    }
    case "prepared": {
      const observer = observerFor(d, op.network);
      if (!observer) return 0;
      try {
        await observer.submit(preparedFrom(op));
      } catch (err) {
        if ((err as { definitive?: boolean }).definitive) {
          return (await step(d, tenantId, op, (tx) => moveOperation(tx, op.id, "failed", { error: (err as Error).message }))) ? 1 : 0;
        }
        // Not definitive: it may or may not have reached the network. Let the chain decide.
        return observeAndMove(d, tenantId, op, observer);
      }
      return (await step(d, tenantId, op, (tx) => moveOperation(tx, op.id, "submitted"))) ? 1 : 0;
    }
    case "submitted":
    case "observed": {
      const observer = observerFor(d, op.network);
      return observer ? observeAndMove(d, tenantId, op, observer) : 0;
    }
    case "confirmed":
      return (await step(d, tenantId, op, (tx) => moveOperation(tx, op.id, "business_completed"))) ? 1 : 0;
    default:
      return 0;
  }
}

async function observeAndMove(d: EngineDeps, tenantId: string, op: OperationRow, observer: ChainObservationPort): Promise<number> {
  const obs = await observer.observe({
    network: op.network,
    txRef: op.tx_ref!,
    ...(op.last_valid_block_height ? { lastValidBlockHeight: BigInt(op.last_valid_block_height) } : {}),
    ...(op.expires_at ? { expiresAt: op.expires_at } : {}),
  });
  const steps = stepsAfterObservation(op.state, obs);
  if (steps.length === 0) {
    // Still pending: re-send the very same signed bytes (it cannot land twice).
    if (obs.status === "pending" || obs.status === "not_found") await observer.submit(preparedFrom(op)).catch(() => undefined);
    return 0;
  }
  const ok = await step(d, tenantId, op, async (tx) => {
    for (const s of steps) {
      await moveOperation(tx, op.id, s, {
        ...(obs.slotOrBlock !== undefined ? { slotOrBlock: obs.slotOrBlock } : {}),
        ...(obs.confirmations !== undefined ? { confirmations: obs.confirmations } : {}),
        ...(obs.feePaid !== undefined ? { feePaid: obs.feePaid } : {}),
        ...(obs.error ? { error: obs.error } : {}),
      });
    }
  });
  return ok ? steps.length : 0;
}
