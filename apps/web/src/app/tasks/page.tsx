"use client";
import Link from "next/link";
import { useState } from "react";
import { EmptyState, Notice, PageHeader } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { TaskGroupsView } from "@/components/Tasks";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery } from "@/lib/api";

export default function MyTasksPage() {
  const t = useI18n().m.tasks;
  return (
    <>
      <PageHeader
        title={t.myTitle}
        description={t.myDescription}
        actions={
          <Link href="/schedule" className="mf-button">
            {t.today.schedule}
          </Link>
        }
      />
      <RequireTenant>{(tenantId) => <MyTasks tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

function MyTasks({ tenantId }: { tenantId: string }) {
  const t = useI18n().m.tasks;
  const [version, setVersion] = useState(0);
  const tasks = useQuery(
    `my-tasks:${tenantId}:${version}`,
    () => unwrap(api.GET("/v1/tenants/{tenantId}/tasks", { params: { path: { tenantId }, query: { assignee: "me", status: "open", limit: 300 } } })),
    // Pick up work assigned while the page is open.
    { pollMs: 60_000 },
  );
  if (tasks.loading && !tasks.data) return <p role="status">{t.loading}</p>;
  if (tasks.error) return <Notice tone="error" title={t.couldNotLoad}>{tasks.error.message}</Notice>;
  const items = tasks.data?.items ?? [];
  if (items.length === 0) return <EmptyState title={t.myEmpty} />;
  return <TaskGroupsView items={items} tenantId={tenantId} showFarm onChanged={() => setVersion((v) => v + 1)} />;
}
