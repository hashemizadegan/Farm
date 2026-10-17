"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Notice, ProvenanceBadge } from "@metafarm/ui";
import { PlanEditor } from "@/components/PlanEditor";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";

export default function FarmOverviewPage() {
  const { farmId } = useParams<{ farmId: string }>();
  return <RequireTenant>{(tenantId) => <Overview tenantId={tenantId} farmId={farmId} />}</RequireTenant>;
}

function Overview({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const farm = useQuery(`farm:${farmId}`, () => unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}", { params: { path: { tenantId, farmId } } })));
  if (farm.loading) return <p role="status">Loading farm…</p>;
  if (farm.error) return <Notice tone="error" title="Could not load this farm.">{farm.error.status === 404 ? "It does not exist or you do not have access." : farm.error.message}</Notice>;
  const f = farm.data!;
  return (
    <>
      <h1>{f.name}</h1>
      {f.description && <p className="mf-page-header__desc">{f.description}</p>}
      <div className="card" style={{ marginTop: "1.25rem" }}>
        <dl className="facts">
          <div>
            <dt>Origin point</dt>
            <dd>
              {f.origin ? `${f.origin.lat.toFixed(6)}, ${f.origin.lon.toFixed(6)}` : "Not set"} <ProvenanceBadge label={f.originProvenance} />
            </dd>
          </div>
          <div>
            <dt>Boundary</dt>
            <dd>
              {f.currentBoundaryVersionId ? (
                <Link href={`/farms/${farmId}/boundary`}>Validated. Review versions</Link>
              ) : (
                <Link href={`/farms/${farmId}/boundary`}>Not validated yet. Review submissions</Link>
              )}
            </dd>
          </div>
          <div>
            <dt>Time zone</dt>
            <dd>{f.timezone.replace(/_/g, " ")}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>
              <time dateTime={f.createdAt}>{new Date(f.createdAt).toLocaleDateString()}</time>
            </dd>
          </div>
        </dl>
      </div>
      <PlanEditor tenantId={tenantId} farmId={farmId} />
    </>
  );
}
