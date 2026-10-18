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
  getOperation,
  getOrder,
  getRepresentation,
  intentsToDrive,
  issuanceContext,
  latestOperation,
  moveOperation,
  operationsToDrive,
  orderForReconciliation,
  ordersAwaitingIssuance,
  setIntentStatus,
  withSystem,
  withTenant,
  type OperationRow,
  type Pool,
  type TenantTx,
} from "@metafarm/db";
import {
  complianceDecision,
  networkAllowed,
  railOf,
  secondLegMayStart,
  stepsAfterObservation,
  type AssetIssuancePort,
  type ChainObservationPort,
  type CompliancePolicy,
  type Network,
  type PreparedTransaction,
} from "@metafarm/domain";

export interface Rails {
  solana?: { network: Network; issuance: AssetIssuancePort; observer: ChainObservationPort };
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
  const started = await startIssuances(d);
  const attempts = await driveIntents(d);
  const moves = await driveOperations(d);
  return { started, attempts, moves };
}

/** Paid subscriptions get their mint intent once the payment leg is complete and correct. */
async function startIssuances(d: EngineDeps): Promise<number> {
  const solana = d.rails.solana;
  if (!solana) return 0;
  let n = 0;
  for (const o of await withSystem(d.pool, (tx) => ordersAwaitingIssuance(tx))) {
    n += await withTenant(d.pool, o.tenant_id, async (tx) => {
      const order = await getOrder(tx, o.id, true);
      if (!order || order.status !== "issuing" || !order.representation_id || !order.investor_solana_address || !order.share_amount) return 0;
      const rep = await getRepresentation(tx, order.representation_id);
      if (!rep?.mint_address || rep.network !== solana.network) return 0;
      const view = await orderForReconciliation(tx, o.id);
      if (!view || !secondLegMayStart(view.order, view.intents)) return 0;
      await createIssuanceIntent(tx, {
        representationId: rep.id,
        action: "mint",
        amount: BigInt(order.share_amount),
        holder: order.investor_solana_address,
        reconciliationId: order.reconciliation_id,
        partyId: order.party_id,
        decision: { reason: "subscription payment verified on chain" },
      });
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

const observerFor = (d: EngineDeps, network: Network) => (railOf(network) === "solana" && d.rails.solana?.network === network ? d.rails.solana.observer : undefined);

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
  const op = await withTenant(d.pool, tenantId, (tx) => getOperation(tx, id));
  if (!op || op.intent_type !== "issuance") return 0;
  const ctx = await withTenant(d.pool, tenantId, (tx) => issuanceContext(tx, op.intent_id));
  if (!ctx) return 0;

  switch (op.state) {
    case "requested": {
      // Compliance and network gates, decided now (KYC or screenings may have changed since the order).
      const verdict = await withTenant(d.pool, tenantId, async (tx) => {
        if (!networkAllowed(op.network, { mainnetEnabled: d.mainnetEnabled })) return { allowed: false, reasons: ["network_not_enabled"] };
        if (!ctx.party_id) return { allowed: false, reasons: ["no_party"] };
        const view = await complianceView(tx, ctx.party_id, [{ network: ctx.network, address: ctx.holder_address }]);
        return view ? complianceDecision(view.party, view.wallets, d.policy, d.now()) : { allowed: false, reasons: ["no_party"] };
      });
      const ok = await step(d, tenantId, op, async (tx) => {
        await tx.query(`UPDATE issuance_intents SET policy_decision = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, op.intent_id, JSON.stringify({ ...verdict, at: d.now().toISOString() })]);
        await moveOperation(tx, op.id, verdict.allowed ? "policy_approved" : "policy_rejected", verdict.allowed ? {} : { error: verdict.reasons.join(", ") });
      });
      return ok ? 1 : 0;
    }
    case "policy_approved": {
      const solana = d.rails.solana;
      if (!solana || solana.network !== op.network || !ctx.mint_address || ctx.decimals === null) return 0;
      const prepared = await solana.issuance.prepareIssuance({
        network: op.network,
        action: ctx.action,
        mintAddress: ctx.mint_address,
        decimals: ctx.decimals,
        holderAddress: ctx.holder_address,
        ...(ctx.amount ? { amount: BigInt(ctx.amount) } : {}),
      });
      const ok = await step(d, tenantId, op, (tx) =>
        moveOperation(tx, op.id, "prepared", {
          txRef: prepared.txRef,
          signedWire: prepared.wire,
          ...(prepared.validity.lastValidBlockHeight !== undefined ? { lastValidBlockHeight: prepared.validity.lastValidBlockHeight } : {}),
          ...(prepared.validity.expiresAt ? { expiresAt: prepared.validity.expiresAt } : {}),
          ...(prepared.fees.priorityFeeMicroLamports !== undefined ? { priorityFee: prepared.fees.priorityFeeMicroLamports } : {}),
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
