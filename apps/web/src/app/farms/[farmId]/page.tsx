"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Notice, ProvenanceBadge } from "@metafarm/ui";
import { PlanEditor } from "@/components/PlanEditor";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";
import { useI18n } from "@/i18n/provider";

export default function FarmOverviewPage() {
  const { farmId } = useParams<{ farmId: string }>();
  return <RequireTenant>{(tenantId) => <Overview tenantId={tenantId} farmId={farmId} />}</RequireTenant>;
}

function Overview({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const { m, fmt } = useI18n();
  const t = m.farm;
  const farm = useQuery(`farm:${farmId}`, () => unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}", { params: { path: { tenantId, farmId } } })));
  if (farm.loading) return <p role="status">{t.loading}</p>;
  if (farm.error) return <Notice tone="error" title={t.couldNotLoad}>{farm.error.status === 404 ? t.notFound : farm.error.message}</Notice>;
  const f = farm.data!;
  return (
    <>
      <h1>{f.name}</h1>
      {f.description && <p className="mf-page-header__desc">{f.description}</p>}
      <div className="card" style={{ marginTop: "1.25rem" }}>
        <dl className="facts">
          <div>
            <dt>{t.origin}</dt>
            <dd>
              {f.origin ? <span className="ltr">{`${f.origin.lat.toFixed(6)}, ${f.origin.lon.toFixed(6)}`}</span> : m.common.notSet} <ProvenanceBadge label={f.originProvenance} />
            </dd>
          </div>
          <div>
            <dt>{t.boundary}</dt>
            <dd>
              {f.currentBoundaryVersionId ? (
                <Link href={`/farms/${farmId}/boundary`}>{t.validatedReview}</Link>
              ) : (
                <Link href={`/farms/${farmId}/boundary`}>{t.notValidatedReview}</Link>
              )}
            </dd>
          </div>
          <div>
            <dt>{t.timezone}</dt>
            <dd className="ltr">{f.timezone.replace(/_/g, " ")}</dd>
          </div>
          <div>
            <dt>{t.created}</dt>
            <dd>
              <time dateTime={f.createdAt}>{fmt.date(f.createdAt)}</time>
            </dd>
          </div>
        </dl>
      </div>
      <PlanEditor tenantId={tenantId} farmId={farmId} />
    </>
  );
}
