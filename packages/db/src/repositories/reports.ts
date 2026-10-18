import type { TenantTx } from "../tenant";

export interface ReportFilter {
  farmId?: string;
  /** Inclusive calendar days (YYYY-MM-DD), read in each farm's own time zone. */
  from: string;
  to: string;
}

/**
 * Totals for a period, from what the team recorded. Nothing is estimated: spending is only what
 * was entered as a cost (deliveries, servicing), grouped by currency; quantities stay per unit.
 * Archived farms are left out unless asked for by id.
 */
export async function periodReport(tx: TenantTx, f: ReportFilter) {
  const p = [tx.tenantId, f.farmId ?? null, f.from, f.to];
  // Farms in scope, with the day in each farm's zone for timestamp columns.
  const farms = `SELECT id, name, timezone FROM farms WHERE tenant_id = $1 AND ($2::uuid IS NULL AND archived_at IS NULL OR id = $2)`;
  const inPeriod = (ts: string) => `(${ts} AT TIME ZONE sf.timezone)::date BETWEEN $3::date AND $4::date`;

  const [tasksDone, byKind, byPerson, dueOpen, inputs, harvests, deliveries, servicing, alerts, observations, perFarm] = await Promise.all([
    tx.query<{ n: number }>(
      `WITH sf AS (${farms}) SELECT count(*)::int AS n FROM farm_tasks t JOIN sf ON sf.id = t.farm_id
        WHERE t.tenant_id = $1 AND t.status = 'done' AND ${inPeriod("t.completed_at")}`,
      p,
    ),
    tx.query<{ kind: string; n: number }>(
      `WITH sf AS (${farms}) SELECT t.kind, count(*)::int AS n FROM farm_tasks t JOIN sf ON sf.id = t.farm_id
        WHERE t.tenant_id = $1 AND t.status = 'done' AND ${inPeriod("t.completed_at")} GROUP BY t.kind ORDER BY n DESC, t.kind`,
      p,
    ),
    tx.query<{ user_id: string | null; name: string | null; n: number }>(
      `WITH sf AS (${farms}) SELECT t.completed_by AS user_id, coalesce(u.display_name, u.email::text) AS name, count(*)::int AS n
         FROM farm_tasks t JOIN sf ON sf.id = t.farm_id LEFT JOIN users u ON u.id = t.completed_by
        WHERE t.tenant_id = $1 AND t.status = 'done' AND ${inPeriod("t.completed_at")}
        GROUP BY t.completed_by, u.display_name, u.email ORDER BY n DESC, name`,
      p,
    ),
    tx.query<{ due: number; open: number }>(
      `WITH sf AS (${farms}) SELECT count(*)::int AS due, count(*) FILTER (WHERE t.status IN ('todo', 'in_progress'))::int AS open
         FROM farm_tasks t JOIN sf ON sf.id = t.farm_id
        WHERE t.tenant_id = $1 AND t.status <> 'cancelled' AND t.due_date BETWEEN $3::date AND $4::date`,
      p,
    ),
    tx.query<{ item_id: string; name: string; category: string; unit: string; used: string; applications: number }>(
      `WITH sf AS (${farms}) SELECT i.id AS item_id, i.name, i.category, i.unit, (-sum(m.quantity))::text AS used, count(*)::int AS applications
         FROM stock_movements m JOIN sf ON sf.id = m.farm_id JOIN input_items i ON i.tenant_id = m.tenant_id AND i.id = m.item_id
        WHERE m.tenant_id = $1 AND m.kind = 'use' AND m.occurred_on BETWEEN $3::date AND $4::date
        GROUP BY i.id, i.name, i.category, i.unit ORDER BY i.category, lower(i.name)`,
      p,
    ),
    tx.query<{ crop: string; unit: string; quantity: string; batches: number }>(
      `WITH sf AS (${farms}) SELECT h.crop_name AS crop, h.unit, sum(h.quantity)::text AS quantity, count(*)::int AS batches
         FROM harvest_batches h JOIN sf ON sf.id = h.farm_id
        WHERE h.tenant_id = $1 AND h.voided_at IS NULL AND h.harvested_on BETWEEN $3::date AND $4::date
        GROUP BY h.crop_name, h.unit ORDER BY lower(h.crop_name), h.unit`,
      p,
    ),
    // Deliveries into the store: farm-specific ones count for that farm; the rest only in the workspace report.
    tx.query<{ currency: string; amount: string; n: number }>(
      `SELECT m.currency, sum(m.cost)::text AS amount, count(*)::int AS n FROM stock_movements m
        WHERE m.tenant_id = $1 AND m.kind = 'receive' AND m.cost IS NOT NULL AND m.currency IS NOT NULL
          AND m.occurred_on BETWEEN $3::date AND $4::date AND ($2::uuid IS NULL OR m.farm_id = $2)
        GROUP BY m.currency ORDER BY m.currency`,
      p,
    ),
    tx.query<{ currency: string; amount: string; n: number }>(
      `SELECT s.currency, sum(s.cost)::text AS amount, count(*)::int AS n FROM service_records s
         JOIN equipment e ON e.tenant_id = s.tenant_id AND e.id = s.equipment_id
        WHERE s.tenant_id = $1 AND s.cost IS NOT NULL AND s.currency IS NOT NULL
          AND s.done_on BETWEEN $3::date AND $4::date AND ($2::uuid IS NULL OR e.farm_id = $2)
        GROUP BY s.currency ORDER BY s.currency`,
      p,
    ),
    tx.query<{ severity: string; n: number }>(
      `WITH sf AS (${farms}) SELECT a.severity, count(*)::int AS n FROM alerts a JOIN sf ON sf.id = a.farm_id
        WHERE a.tenant_id = $1 AND ${inPeriod("a.created_at")} GROUP BY a.severity`,
      p,
    ),
    tx.query<{ provenance: string; n: number }>(
      `WITH sf AS (${farms}) SELECT o.provenance_label AS provenance, count(*)::int AS n FROM observations o JOIN sf ON sf.id = o.farm_id
        WHERE o.tenant_id = $1 AND ${inPeriod("o.observed_at")} GROUP BY o.provenance_label`,
      p,
    ),
    tx.query<{ farm_id: string; name: string; tasks_done: number; applications: number; harvest_batches: number; alerts: number }>(
      `WITH sf AS (${farms})
       SELECT sf.id AS farm_id, sf.name,
              (SELECT count(*) FROM farm_tasks t WHERE t.tenant_id = $1 AND t.farm_id = sf.id AND t.status = 'done' AND ${inPeriod("t.completed_at")})::int AS tasks_done,
              (SELECT count(*) FROM stock_movements m WHERE m.tenant_id = $1 AND m.farm_id = sf.id AND m.kind = 'use' AND m.occurred_on BETWEEN $3::date AND $4::date)::int AS applications,
              (SELECT count(*) FROM harvest_batches h WHERE h.tenant_id = $1 AND h.farm_id = sf.id AND h.voided_at IS NULL AND h.harvested_on BETWEEN $3::date AND $4::date)::int AS harvest_batches,
              (SELECT count(*) FROM alerts a WHERE a.tenant_id = $1 AND a.farm_id = sf.id AND ${inPeriod("a.created_at")})::int AS alerts
         FROM sf ORDER BY lower(sf.name)`,
      p,
    ),
  ]);

  return {
    tasksDone: tasksDone.rows[0]!.n,
    byKind: byKind.rows,
    byPerson: byPerson.rows,
    tasksDue: dueOpen.rows[0]!.due,
    tasksDueStillOpen: dueOpen.rows[0]!.open,
    inputs: inputs.rows,
    harvests: harvests.rows,
    deliveries: deliveries.rows,
    servicing: servicing.rows,
    alerts: alerts.rows,
    observations: observations.rows,
    perFarm: perFarm.rows,
  };
}
