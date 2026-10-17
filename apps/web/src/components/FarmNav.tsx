"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { StatusPill } from "@metafarm/ui";
import { PlotOutline } from "@/components/PlotOutline";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";
import { useTenant } from "@/lib/tenant";

const TABS = [
  ["", "Overview"],
  ["/boundary", "Boundary"],
  ["/scenarios", "Crop scenarios"],
  ["/observations", "Observations"],
  ["/alerts", "Alerts"],
  ["/scene", "3D scene"],
  ["/files", "Files"],
  ["/settings", "Settings"],
] as const;

/** Breadcrumb, farm status and section tabs shared by every farm page. */
export function FarmNav({ farmId }: { farmId: string }) {
  const pathname = usePathname();
  const { tenantId } = useTenant();
  const can = useCan();
  const farm = useQuery(tenantId ? `farm-head:${tenantId}:${farmId}:${pathname}` : null, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}", { params: { path: { tenantId: tenantId!, farmId } } })),
  );
  const f = farm.data;

  return (
    <>
      <div className="farm-head">
        <span className="farm-head__plot">
          <PlotOutline outline={f?.outline} size={44} title={f?.outline ? "Outline of the current boundary" : undefined} />
        </span>
        <div className="farm-head__text">
          <nav aria-label="Breadcrumb" className="crumbs">
            <ol>
              <li>
                <Link href="/farms">Farms</Link>
              </li>
              <li aria-current="page">{f?.name ?? "Farm"}</li>
            </ol>
          </nav>
          {f && (
            <div className="farm-head__meta">
              {f.archivedAt ? <StatusPill tone="neutral">Archived</StatusPill> : null}
              {f.currentBoundaryVersionId ? (
                <StatusPill tone="ok">Validated boundary</StatusPill>
              ) : (
                <StatusPill tone="pending">No validated boundary yet</StatusPill>
              )}
            </div>
          )}
        </div>
      </div>
      <nav aria-label="Farm sections" className="farm-tabs">
        <ul>
          {TABS.filter(([suffix]) => suffix !== "/settings" || can("farm:write")).map(([suffix, label]) => {
            const href = `/farms/${farmId}${suffix}`;
            return (
              <li key={suffix}>
                <Link href={href} aria-current={pathname === href ? "page" : undefined}>
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
