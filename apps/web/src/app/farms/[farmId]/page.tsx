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
      {f.description && <p>{f.description}</p>}
      <dl className="card">
        <dt>Origin point</dt>
        <dd>
          {f.origin ? `${f.origin.lat.toFixed(6)}, ${f.origin.lon.toFixed(6)}` : "Not set"} <ProvenanceBadge label={f.originProvenance} />
        </dd>
        <dt>Boundary</dt>
        <dd>{f.currentBoundaryVersionId ? "A validated boundary is in place." : <Link href={`/farms/${farmId}/boundary`}>No validated boundary yet — review submissions</Link>}</dd>
        <dt>Time zone</dt>
        <dd>{f.timezone}</dd>
      </dl>
      <PlanEditor tenantId={tenantId} farmId={farmId} />
    </>
  );
}
