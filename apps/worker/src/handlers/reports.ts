import { listTenantsWithFarms, membersWithRoles, notificationSent, notify, periodReport, withSystem, withTenant, type Pool } from "@metafarm/db";
import { readWorkspaceSettings, rolesWith, weeklyReportDue } from "@metafarm/domain";
import type { Handler } from "../runner";

/**
 * Weekly summary: on the first morning of each week (workspace time zone, 07:00), owners, admins
 * and managers get a notification with last week's totals and a link to the full report.
 * Once per workspace and week; skipped when nothing at all was recorded.
 */
export function weeklyReportSweepHandler(pool: Pool, now: () => Date = () => new Date()): Handler<{ bucket: string }> {
  return async (_job, { log }) => {
    const tenants = await withSystem(pool, (tx) => listTenantsWithFarms(tx));
    let sent = 0;
    for (const t of tenants) {
      const { weeklyReport } = readWorkspaceSettings(t.settings, t.timezone);
      if (!weeklyReport.enabled) continue;
      const week = weeklyReportDue(now(), t.timezone ?? "UTC", weeklyReport.weekStartsOn);
      if (!week) continue;
      const key = `weekly:${week.from}`;
      sent += await withTenant(pool, t.id, async (tx) => {
        if (await notificationSent(tx, key)) return 0;
        const r = await periodReport(tx, week);
        const data = {
          ...week,
          tasksDone: r.tasksDone,
          dueStillOpen: r.tasksDueStillOpen,
          applications: r.inputs.reduce((s, i) => s + i.applications, 0),
          harvestBatches: r.harvests.reduce((s, h) => s + h.batches, 0),
          alerts: r.alerts.reduce((s, a) => s + a.n, 0),
        };
        if (!data.tasksDone && !r.tasksDue && !data.applications && !data.harvestBatches && !data.alerts) return 0;
        return notify(tx, await membersWithRoles(tx, rolesWith("task:manage")), "weekly_report", data, key);
      });
    }
    if (sent) log.info({ sent }, "weekly summaries sent");
    return { tenants: tenants.length, sent };
  };
}
