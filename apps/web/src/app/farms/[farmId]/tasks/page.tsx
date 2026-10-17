"use client";
import { useParams } from "next/navigation";
import { useState } from "react";
import { EmptyState, Notice } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { NewTaskForm, TaskGroupsView } from "@/components/Tasks";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";

export default function FarmTasksPage() {
  const { farmId } = useParams<{ farmId: string }>();
  const t = useI18n().m.tasks;
  return (
    <>
      <h1>{t.title}</h1>
      <p className="mf-hint">{t.farmIntro}</p>
      <RequireTenant>{(tenantId) => <FarmTasks tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}

function FarmTasks({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const t = useI18n().m.tasks;
  const can = useCan();
  const [showDone, setShowDone] = useState(false);
  const [version, setVersion] = useState(0);
  const status = showDone ? "all" : "open";
  const tasks = useQuery(`tasks:${farmId}:${status}:${version}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/tasks", { params: { path: { tenantId, farmId }, query: { status, limit: 300 } } })),
  );
  const reload = () => setVersion((v) => v + 1);
  const items = tasks.data?.items ?? [];

  return (
    <>
      {tasks.loading && !tasks.data && <p role="status">{t.loading}</p>}
      {tasks.error && (
        <Notice tone="error" title={t.couldNotLoad}>
          {tasks.error.message}
        </Notice>
      )}
      {tasks.data && items.length === 0 && (
        <EmptyState title={t.noTasksFarm}>{can("task:manage") ? t.noTasksFarmManager : undefined}</EmptyState>
      )}
      <TaskGroupsView items={items} tenantId={tenantId} onChanged={reload} />
      <p>
        <button type="button" className="mf-button mf-button--small" aria-pressed={showDone} onClick={() => setShowDone((s) => !s)}>
          {showDone ? t.hideDone : t.showDone}
        </button>
      </p>
      {can("task:manage") && <NewTaskForm tenantId={tenantId} farmId={farmId} onCreated={reload} />}
    </>
  );
}
