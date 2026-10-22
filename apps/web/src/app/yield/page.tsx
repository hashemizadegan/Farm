"use client";
import Link from "next/link";
import { useState } from "react";
import { EmptyState, Notice, PageHeader, StatusPill } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";
import { MAX_LIST_PAGES, allPages, shortAddress } from "@/lib/rwa";
import { viewState, yieldPagesEnabled, yieldStatusKey, yieldTone } from "@/lib/yield";

/**
 * Y10: yield cycles, read only, for staff. Behind NEXT_PUBLIC_YIELD_PAGES_ENABLED (off by default) and
 * yield:read. Not an approved disclosure (D-39): the page says so and is never shown to holders.
 */
export default function YieldPage() {
  const t = useI18n().m.yield;
  if (!yieldPagesEnabled()) return <Notice tone="info">{t.disabled}</Notice>;
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <Notice tone="warning">{t.internalOnly}</Notice>
      <RequireTenant>{(tenantId) => <Cycles tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

type Cycle = Schemas["YieldCycle"];
const STATUSES = ["draft", "inputs_locked", "calculated", "under_review", "approved", "published", "disputed", "closed", "cancelled", "abandoned", "superseded"] as const;

function Cycles({ tenantId }: { tenantId: string }) {
  const { m, fmt } = useI18n();
  const t = m.yield;
  const can = useCan();
  const allowed = can("yield:read");
  const [status, setStatus] = useState<(typeof STATUSES)[number] | "">("");
  const cycles = useQuery(allowed ? `yield-cycles:${tenantId}:${status}` : null, () =>
    allPages((cursor) => unwrap(api.GET("/v1/tenants/{tenantId}/yield/cycles", { params: { path: { tenantId }, query: { limit: 100, cursor, ...(status ? { status } : {}) } } }))),
  );
  if (!allowed) return <Notice tone="info">{t.noAccess}</Notice>;
  const state = viewState(cycles, (d) => d.items.length === 0);

  return (
    <section aria-labelledby="yield-cycles">
      <Notice tone="info">{t.readOnly}</Notice>
      <h2 id="yield-cycles">{t.title}</h2>
      <label>
        {t.filterStatus}{" "}
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="">{t.allStatuses}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t.statuses[s] ?? s}
            </option>
          ))}
        </select>
      </label>
      {state === "loading" && <p role="status">{t.loading}</p>}
      {state === "error" && (
        <Notice tone="error" title={t.couldNotLoad}>
          {(cycles.error as Error).message} <button type="button" onClick={cycles.reload}>{t.retry}</button>
        </Notice>
      )}
      {state === "stale" && (
        <Notice tone="warning">
          {t.stale} <button type="button" onClick={cycles.reload}>{t.retry}</button>
        </Notice>
      )}
      {state === "empty" && <EmptyState title={t.empty} />}
      {(state === "fresh" || state === "stale") && cycles.data && (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div className="table-wrap" role="region" aria-label={t.title} tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t.col.period}</th>
                <th scope="col">{t.col.asset}</th>
                <th scope="col">{t.col.version}</th>
                <th scope="col">{t.col.status}</th>
                <th scope="col">{t.col.updated}</th>
              </tr>
            </thead>
            <tbody>
              {cycles.data.items.map((c: Cycle) => (
                <tr key={c.id}>
                  <th scope="row">
                    <Link href={`/yield/${c.id}`}>
                      {c.period.start} – {c.period.end}
                    </Link>{" "}
                    {c.simulation && <StatusPill tone="neutral">{t.simulation}</StatusPill>}
                  </th>
                  <td title={c.chainAsset.id}>
                    {shortAddress(c.chainAsset.id)} · {c.chainAsset.network}
                  </td>
                  <td>{c.version}</td>
                  <td>
                    <StatusPill tone={yieldTone(c.status)}>{t.statuses[yieldStatusKey(c.status, c.closeReason)] ?? c.status}</StatusPill>
                  </td>
                  <td>{fmt.dateTime(c.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cycles.data?.truncated && <Notice tone="warning">{t.listTruncated(cycles.data.items.length, MAX_LIST_PAGES * 100)}</Notice>}
    </section>
  );
}
