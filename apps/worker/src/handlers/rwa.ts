import { openOrders, openReconciliationCases, orderForReconciliation, setOrderStatus, withSystem, withTenant, type Pool } from "@metafarm/db";
import { orderLegsDone, reconcileOrder, type ReconciliationKind } from "@metafarm/domain";
import type { Handler } from "../runner";

/** Discrepancies that mean money or shares may have moved wrongly: the order stops until someone looks. */
const STOPPING: ReadonlySet<ReconciliationKind> = new Set(["amount_mismatch", "duplicate", "missing_settlement", "orphan_chain_tx"]);

/**
 * Reconciles every order still in play: opens one case per discrepancy (once), moves an order to
 * `exception` when something may have moved wrongly, and to `completed` when its legs are done
 * and nothing is wrong.
 */
export function rwaReconciliationSweepHandler(pool: Pool, slaMinutes: number, now: () => Date = () => new Date()): Handler<{ bucket: string }> {
  return async (_job, { log }) => {
    const orders = await withSystem(pool, (tx) => openOrders(tx));
    let opened = 0;
    let completed = 0;
    let exceptions = 0;
    for (const o of orders) {
      await withTenant(pool, o.tenant_id, async (tx) => {
        const view = await orderForReconciliation(tx, o.id);
        if (!view) return;
        const found = reconcileOrder(view.order, view.intents, now(), slaMinutes);
        opened += await openReconciliationCases(tx, view.reconciliationId, found);
        if (found.some((d) => STOPPING.has(d.kind))) {
          if (view.status !== "exception") {
            await setOrderStatus(tx, o.id, "exception");
            exceptions++;
          }
          return;
        }
        if (found.length === 0 && orderLegsDone(view.order, view.intents) && view.status !== "exception") {
          await setOrderStatus(tx, o.id, "completed");
          completed++;
        }
      });
    }
    if (opened || completed || exceptions) log.info({ orders: orders.length, opened, completed, exceptions }, "RWA reconciliation");
    return { orders: orders.length, opened, completed, exceptions };
  };
}
