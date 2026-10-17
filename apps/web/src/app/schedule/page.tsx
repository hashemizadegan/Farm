"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Notice, PageHeader, StatusPill } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import type { Task } from "@/components/Tasks";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery } from "@/lib/api";
import { localToday, shiftDay, weekStart } from "@/lib/dates";

export default function SchedulePage() {
  const t = useI18n().m.tasks;
  return (
    <>
      <PageHeader title={t.scheduleTitle} description={t.scheduleDescription} />
      <RequireTenant>{(tenantId) => <Week tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

/** One week of the team's tasks across all farms, a day per section. */
function Week({ tenantId }: { tenantId: string }) {
  const { m, fmt } = useI18n();
  const t = m.tasks;
  const today = localToday();
  const thisWeek = weekStart(today, fmt.weekStartsOn);
  const [from, setFrom] = useState(thisWeek);
  const [person, setPerson] = useState("");
  const to = shiftDay(from, 6);
  const current = from === thisWeek;

  const members = useQuery(`members:${tenantId}`, () => unwrap(api.GET("/v1/tenants/{tenantId}/members", { params: { path: { tenantId } } })));
  const tasks = useQuery(`schedule:${tenantId}:${from}:${person}`, () =>
    unwrap(
      api.GET("/v1/tenants/{tenantId}/tasks", {
        params: {
          path: { tenantId },
          query: { from, to, status: "all", includeOverdue: current ? "true" : "false", limit: 500, ...(person && person !== "none" ? { assignee: person } : {}) },
        },
      }),
    ),
  );

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => shiftDay(from, i)), [from]);
  const all = (tasks.data?.items ?? []).filter((x) => person !== "none" || !x.assigneeUserId);
  const overdue = all.filter((x) => x.dueDate < from && (x.status === "todo" || x.status === "in_progress"));
  const byDay = (d: string) => all.filter((x) => x.dueDate === d && x.status !== "cancelled");

  return (
    <>
      <div className="week-nav">
        <button type="button" className="mf-button mf-button--small" onClick={() => setFrom(shiftDay(from, -7))}>
          <span aria-hidden="true">‹ </span>
          {t.schedule.previous}
        </button>
        <h2 className="week-nav__range" aria-live="polite">
          {t.schedule.week(fmt.day(from), fmt.day(to))}
        </h2>
        <button type="button" className="mf-button mf-button--small" onClick={() => setFrom(shiftDay(from, 7))}>
          {t.schedule.next}
          <span aria-hidden="true"> ›</span>
        </button>
        {!current && (
          <button type="button" className="mf-button mf-button--small" onClick={() => setFrom(thisWeek)}>
            {t.schedule.thisWeek}
          </button>
        )}
        <div className="week-nav__person">
          <label htmlFor="schedule-person">{t.schedule.person}</label>
          <select id="schedule-person" value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">{t.schedule.everyone}</option>
            <option value="none">{t.schedule.unassigned}</option>
            {(members.data?.items ?? []).map((mb) => (
              <option key={mb.userId} value={mb.userId}>
                {mb.displayName || mb.email || mb.userId.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {tasks.loading && !tasks.data && <p role="status">{t.loading}</p>}
      {tasks.error && (
        <Notice tone="error" title={t.couldNotLoad}>
          {tasks.error.message}
        </Notice>
      )}
      {current && overdue.length > 0 && (
        <Notice tone="warning" title={t.groups.overdue}>
          {t.schedule.overdueNote(overdue.length)}
          <ul className="week-day__list">
            {overdue.map((x) => (
              <ScheduleItem key={x.id} task={x} />
            ))}
          </ul>
        </Notice>
      )}

      <ol className="week">
        {days.map((d) => {
          const list = byDay(d);
          return (
            <li key={d} className="week-day" data-today={d === today || undefined} aria-labelledby={`day-${d}`}>
              <h3 id={`day-${d}`} className="week-day__heading">
                {fmt.weekday(d)}
                {d === today && <span className="week-day__today"> · {t.groups.today}</span>}
              </h3>
              {list.length === 0 ? (
                <p className="mf-hint">{t.schedule.nothing}</p>
              ) : (
                <ul className="week-day__list">
                  {list.map((x) => (
                    <ScheduleItem key={x.id} task={x} />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

function ScheduleItem({ task }: { task: Task }) {
  const t = useI18n().m.tasks;
  return (
    <li className="week-item" data-status={task.status}>
      <Link href={`/farms/${task.farmId}/tasks`} className="week-item__title">
        {task.title}
      </Link>
      <span className="week-item__meta">
        {task.farmName} · {t.kinds[task.kind]}
        {task.parcelLabel ? ` · ${task.parcelLabel}` : ""} · {task.assigneeUserId ? (task.assigneeName ?? t.card.someone) : t.card.unassigned}
      </span>
      {task.status === "done" && <StatusPill tone="ok">{t.statuses.done}</StatusPill>}
      {task.status === "in_progress" && <StatusPill tone="pending">{t.statuses.in_progress}</StatusPill>}
      {task.status !== "done" && task.priority === "high" && <StatusPill tone="problem">{t.priorities.high}</StatusPill>}
    </li>
  );
}
