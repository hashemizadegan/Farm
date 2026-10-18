import { farmsWithAlertRules, insertAlertOnce, listEnabledRules, listObservations, silentSensors, withSystem, withTenant, writeAudit, type Pool } from "@metafarm/db";
import { QUEUES, evaluateAlertRule, type AlertEvaluationJob, type JobPayloads, type NormalisedObservation } from "@metafarm/domain";
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
      const isNew = await withTenant(pool, s.tenant_id, (tx) =>
        insertAlertOnce(tx, {
          farmId: s.farm_id,
          sensorId: s.id,
          severity: "warning",
          message: `Sensor "${s.name}" has sent no readings since ${since.replace("T", " ").slice(0, 16)} UTC.`,
          dedupeKey: `sensor-silent:${s.id}:${since}`,
          evidence: [],
        }),
      );
      if (isNew) created++;
    }
    if (rows.length) log.info({ silent: rows.length, created }, "silent sensors checked");
    return { silent: rows.length, created };
  };
}
