"use client";
import Link from "next/link";
import { useState } from "react";
import { EmptyState, Notice, PageHeader, StatusPill } from "@metafarm/ui";
import { PlotOutline } from "@/components/PlotOutline";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";
import { useI18n } from "@/i18n/provider";

export default function FarmsPage() {
  const can = useCan();
  const { m: msgs } = useI18n();
  const t = msgs.farms;
  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          can("farm:write") ? (
            <Link href="/farms/new" className="mf-button mf-button--primary">
              {msgs.overview.createFarm}
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
  const { m, fmt } = useI18n();
  const t = m.farms;
  const farms = useQuery(`farms:${tenantId}:${status}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms", { params: { path: { tenantId }, query: { limit: 100, status } } })),
  );
  const items = farms.data?.items ?? [];

  return (
    <>
      <div className="mf-toolbar" role="group" aria-label={t.show}>
        <button type="button" className="mf-button mf-button--small" aria-pressed={status === "active"} onClick={() => setStatus("active")}>
          {t.active}
        </button>
        <button type="button" className="mf-button mf-button--small" aria-pressed={status === "archived"} onClick={() => setStatus("archived")}>
          {t.archived}
        </button>
      </div>
      {farms.loading && !farms.data && <p role="status">{t.loading}</p>}
      {farms.error && <Notice tone="error" title={m.overview.couldNotLoad}>{farms.error.message}</Notice>}
      {farms.data && items.length === 0 &&
        (status === "active" ? (
          <EmptyState title={t.emptyTitle}>{t.emptyText}</EmptyState>
        ) : (
          <p>{t.noArchived}</p>
        ))}
      {items.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="mf-visually-hidden">{status === "active" ? t.captionActive : t.captionArchived}</caption>
            <thead>
              <tr>
                <th scope="col">{t.colName}</th>
                <th scope="col">{t.colBoundary}</th>
                <th scope="col">{t.colTimezone}</th>
                <th scope="col">{t.colCreated}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id}>
                  <th scope="row">
                    <div className="name-cell">
                      <PlotOutline outline={f.outline} size={36} />
                      <div>
                        <Link href={`/farms/${f.id}`}>{f.name}</Link>
                        {f.description && <p className="mf-hint">{f.description.length > 90 ? `${f.description.slice(0, 90)}…` : f.description}</p>}
                      </div>
                    </div>
                  </th>
                  <td>{f.currentBoundaryVersionId ? <StatusPill tone="ok">{t.validated}</StatusPill> : <StatusPill tone="pending">{t.needsBoundary}</StatusPill>}</td>
                  <td className="ltr">{f.timezone.replace(/_/g, " ")}</td>
                  <td>
                    <time dateTime={f.createdAt}>{fmt.date(f.createdAt)}</time>
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
