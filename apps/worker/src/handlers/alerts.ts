import {
  farmsWithAlertRules,
  getFarm,
  insertAlertOnce,
  listEnabledRules,
  listObservations,
  membersWithRoles,
  notify,
  silentSensors,
  withSystem,
  withTenant,
  writeAudit,
  type Pool,
  type TenantTx,
} from "@metafarm/db";
import { QUEUES, dayInZone, evaluateAlertRule, maintenanceDue, rolesWith, type AlertEvaluationJob, type JobPayloads, type NormalisedObservation } from "@metafarm/domain";

/** Tells the people who handle alerts on this farm. */
async function notifyAlert(tx: TenantTx, farmId: string, severity: string, message: string, dedupeKey: string) {
  const farm = await getFarm(tx, farmId);
  await notify(tx, await membersWithRoles(tx, rolesWith("alert:ack")), "alert_raised", { farmId, farmName: farm?.name ?? "", severity, message }, `alert:${dedupeKey}`);
}
import type { Handler } from "../runner";

export interface Enqueue {
  <Q extends keyof JobPayloads>(queue: Q, payload: JobPayloads[Q]): Promise<void>;
}

/** Evaluates every enabled rule for one farm. Alerts are de-duplicated by key. */
export function alertEvaluationHandler(pool: Pool, now: () => Date = () => new Date()): Handler<AlertEvaluationJob> {
  return async (job, { log }) =>
    withTenant(pool, job.tenantId, async (tx) => {
      const rules = await listEnabledRules(tx, job.farmId);
      let created = 0;
      for (const rule of rules) {
        const since = new Date(now().getTime() - rule.windowSeconds * 1000).toISOString();
        const rows = await listObservations(tx, job.farmId, { metric: rule.metric, since, limit: 100 });
        const obs = rows.map((r) => ({
          id: r.id,
          metric: r.metric as NormalisedObservation["metric"],
          value: r.value,
          text: r.text_value,
          unit: r.unit,
          originalValue: r.value ?? "",
          originalUnit: r.unit,
          observedAt: new Date(r.observed_at).toISOString(),
          provenance: r.provenance_label,
          qualityFlags: r.quality_flags,
        }));
        const ev = evaluateAlertRule(rule, obs, now());
        if (ev.fired && ev.dedupeKey && ev.message) {
          const isNew = await insertAlertOnce(tx, {
            farmId: job.farmId,
            ruleId: rule.id,
            severity: rule.severity,
            message: ev.message,
            dedupeKey: ev.dedupeKey,
            evidence: ev.evidenceObservationIds,
          });
          if (isNew) {
            created++;
            await notifyAlert(tx, job.farmId, rule.severity, ev.message, ev.dedupeKey);
            await writeAudit(tx, { actorType: "job", action: "alert.raised", targetType: "alert_rule", targetId: rule.id, metadata: { severity: rule.severity } });
          }
        }
      }
      log.info({ rules: rules.length, created }, "alerts evaluated");
      return { rules: rules.length, created };
    });
}

/**
 * Scheduled sweep: lists farms that have alert rules (cross-tenant, system
 * scope, read-only) and enqueues one tenant-scoped evaluation per farm.
 */
export function alertSweepHandler(pool: Pool, enqueue: Enqueue): Handler<{ bucket: string }> {
  return async (job, { log }) => {
    const farms = await withSystem(pool, (tx) => farmsWithAlertRules(tx));
    for (const f of farms) {
      await enqueue(QUEUES.alerts, { tenantId: f.tenant_id, farmId: f.farm_id, bucket: job.bucket });
    }
    log.info({ farms: farms.length }, "alert sweep fanned out");
    return { farms: farms.length };
  };
}

/** Re-queues boundaries stuck in `pending` (e.g. if the API's enqueue failed after commit). */
export function pendingBoundarySweepHandler(pool: Pool, enqueue: Enqueue): Handler<{ bucket: string }> {
  return async (_job, { log }) => {
    const rows = await withSystem(pool, async (tx) =>
      (
        await tx.query<{ tenant_id: string; farm_id: string; id: string }>(
          `SELECT tenant_id, farm_id, id FROM boundary_versions
            WHERE validation_status = 'pending' AND submitted_at < now() - interval '5 minutes' LIMIT 500`,
        )
      ).rows,
    );
    for (const r of rows) await enqueue(QUEUES.gis, { tenantId: r.tenant_id, farmId: r.farm_id, boundaryVersionId: r.id });
    if (rows.length) log.warn({ count: rows.length }, "re-queued pending boundaries");
    return { requeued: rows.length };
  };
}


/**
 * Raises one warning per silence: a sensor that has reported before but not
 * within its allowance. The key includes the last contact time, so a sensor
 * that comes back and goes quiet again raises a new alert.
 */
export function sensorSilenceSweepHandler(pool: Pool): Handler<{ bucket: string }> {
  return async (_job, { log }) => {
    const rows = await withSystem(pool, (tx) => silentSensors(tx));
    let created = 0;
    for (const s of rows) {
      const since = new Date(s.last_seen_at).toISOString();
      const message = `Sensor "${s.name}" has sent no readings since ${since.replace("T", " ").slice(0, 16)} UTC.`;
      const dedupeKey = `sensor-silent:${s.id}:${since}`;
      const isNew = await withTenant(pool, s.tenant_id, async (tx) => {
        const fresh = await insertAlertOnce(tx, { farmId: s.farm_id, sensorId: s.id, severity: "warning", message, dedupeKey, evidence: [] });
        if (fresh) await notifyAlert(tx, s.farm_id, "warning", message, dedupeKey);
        return fresh;
      });
      if (isNew) created++;
    }
    if (rows.length) log.info({ silent: rows.length, created }, "silent sensors checked");
    return { silent: rows.length, created };
  };
}

/**
 * Notifies equipment managers once for each maintenance plan that is overdue,
 * per due point (a service resets the plan and so the key).
 */
export function maintenanceDueSweepHandler(pool: Pool, now: () => Date = () => new Date()): Handler<{ bucket: string }> {
  return async (_job, { log }) => {
    const rows = await withSystem(pool, async (tx) =>
      (
        await tx.query<{
          tenant_id: string;
          plan_id: string;
          title: string;
          every_hours: number | null;
          every_days: number | null;
          last_done_on: string;
          last_done_hours: string | null;
          equipment_id: string;
          equipment_name: string;
          hours: string | null;
          timezone: string | null;
        }>(
          `SELECT p.tenant_id, p.id AS plan_id, p.title, p.every_hours, p.every_days, to_char(p.last_done_on, 'YYYY-MM-DD') AS last_done_on,
                  p.last_done_hours::text AS last_done_hours, e.id AS equipment_id, e.name AS equipment_name, f.timezone,
                  (SELECT max(hours)::text FROM meter_readings m WHERE m.tenant_id = e.tenant_id AND m.equipment_id = e.id) AS hours
             FROM maintenance_plans p
             JOIN equipment e ON e.tenant_id = p.tenant_id AND e.id = p.equipment_id
             LEFT JOIN farms f ON f.tenant_id = e.tenant_id AND f.id = e.farm_id
            WHERE p.archived_at IS NULL AND e.status <> 'retired'
            LIMIT 5000`,
        )
      ).rows,
    );
    let sent = 0;
    for (const r of rows) {
      const due = maintenanceDue(
        { everyHours: r.every_hours, everyDays: r.every_days, lastDoneOn: r.last_done_on, lastDoneHours: r.last_done_hours === null ? null : Number(r.last_done_hours) },
        { today: dayInZone(now(), r.timezone ?? "UTC"), hours: r.hours === null ? null : Number(r.hours) },
      );
      if (due.state !== "overdue") continue;
      sent += await withTenant(pool, r.tenant_id, async (tx) =>
        notify(
          tx,
          await membersWithRoles(tx, rolesWith("equipment:manage")),
          "maintenance_due",
          { equipmentId: r.equipment_id, equipmentName: r.equipment_name, planTitle: r.title },
          `maint:${r.plan_id}:${r.last_done_on}:${r.last_done_hours ?? ""}`,
        ),
      );
    }
    if (sent) log.info({ sent }, "maintenance notifications sent");
    return { plans: rows.length, sent };
  };
}
