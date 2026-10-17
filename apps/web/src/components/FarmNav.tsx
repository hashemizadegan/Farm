"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { StatusPill } from "@metafarm/ui";
import { PlotOutline } from "@/components/PlotOutline";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";
import { useTenant } from "@/lib/tenant";
import { useI18n } from "@/i18n/provider";

const TABS = [
  ["", "overview"],
  ["/tasks", "tasks"],
  ["/harvests", "harvests"],
  ["/inputs", "inputs"],
  ["/boundary", "boundary"],
  ["/scenarios", "scenarios"],
  ["/observations", "observations"],
  ["/alerts", "alerts"],
  ["/scene", "scene"],
  ["/files", "files"],
  ["/settings", "settings"],
] as const;

/** Breadcrumb, farm status and section tabs shared by every farm page. */
export function FarmNav({ farmId }: { farmId: string }) {
  const pathname = usePathname();
  const { tenantId } = useTenant();
  const can = useCan();
  const { m } = useI18n();
  const t = m.farmNav;
  const farm = useQuery(tenantId ? `farm-head:${tenantId}:${farmId}:${pathname}` : null, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}", { params: { path: { tenantId: tenantId!, farmId } } })),
  );
  const f = farm.data;

  return (
    <>
      <div className="farm-head">
        <span className="farm-head__plot">
          <PlotOutline outline={f?.outline} size={44} title={f?.outline ? t.outline : undefined} />
        </span>
        <div className="farm-head__text">
          <nav aria-label={t.breadcrumb} className="crumbs">
            <ol>
              <li>
                <Link href="/farms">{t.farms}</Link>
              </li>
              <li aria-current="page">{f?.name ?? t.farm}</li>
            </ol>
          </nav>
          {f && (
            <div className="farm-head__meta">
              {f.archivedAt ? <StatusPill tone="neutral">{t.archived}</StatusPill> : null}
              {f.currentBoundaryVersionId ? (
                <StatusPill tone="ok">{t.validated}</StatusPill>
              ) : (
                <StatusPill tone="pending">{t.notValidated}</StatusPill>
              )}
            </div>
          )}
        </div>
      </div>
      <nav aria-label={t.sections} className="farm-tabs">
        <ul>
          {TABS.filter(([suffix]) => suffix !== "/settings" || can("farm:write")).map(([suffix, key]) => {
            const href = `/farms/${farmId}${suffix}`;
            return (
              <li key={suffix}>
                <Link href={href} aria-current={pathname === href ? "page" : undefined}>
                  {t.tabs[key]}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
