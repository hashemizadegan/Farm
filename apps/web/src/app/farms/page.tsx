"use client";
import Link from "next/link";
import { useState } from "react";
import { EmptyState, Notice, PageHeader, StatusPill } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";

export default function FarmsPage() {
  const can = useCan();
  return (
    <>
      <PageHeader
        title="Farms"
        description="Every farm project in this workspace."
        actions={
          can("farm:write") ? (
            <Link href="/farms/new" className="mf-button mf-button--primary">
              Create a farm project
            </Link>
          ) : undefined
        }
      />
      <RequireTenant>{(tenantId) => <FarmList tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

function FarmList({ tenantId }: { tenantId: string }) {
  const [status, setStatus] = useState<"active" | "archived">("active");
  const farms = useQuery(`farms:${tenantId}:${status}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms", { params: { path: { tenantId }, query: { limit: 100, status } } })),
  );
  const items = farms.data?.items ?? [];

  return (
    <>
      <div className="mf-toolbar" role="group" aria-label="Show">
        <button type="button" className="mf-button mf-button--small" aria-pressed={status === "active"} onClick={() => setStatus("active")}>
          Active
        </button>
        <button type="button" className="mf-button mf-button--small" aria-pressed={status === "archived"} onClick={() => setStatus("archived")}>
          Archived
        </button>
      </div>
      {farms.loading && !farms.data && <p role="status">Loading farms…</p>}
      {farms.error && <Notice tone="error" title="Could not load farms.">{farms.error.message}</Notice>}
      {farms.data && items.length === 0 &&
        (status === "active" ? (
          <EmptyState title="No farm projects yet">Create a farm project to set its boundary, plan plantings and record observations.</EmptyState>
        ) : (
          <p>No archived farm projects. Archive a farm from its Settings tab to hide it here without deleting its data.</p>
        ))}
      {items.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="mf-visually-hidden">{status === "active" ? "Active farm projects" : "Archived farm projects"}</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Boundary</th>
                <th scope="col">Time zone</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id}>
                  <th scope="row">
                    <Link href={`/farms/${f.id}`}>{f.name}</Link>
                    {f.description && <p className="mf-hint">{f.description.length > 90 ? `${f.description.slice(0, 90)}…` : f.description}</p>}
                  </th>
                  <td>{f.currentBoundaryVersionId ? <StatusPill tone="ok">Validated</StatusPill> : <StatusPill tone="pending">Needs a boundary</StatusPill>}</td>
                  <td>{f.timezone}</td>
                  <td>
                    <time dateTime={f.createdAt}>{new Date(f.createdAt).toLocaleDateString()}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
