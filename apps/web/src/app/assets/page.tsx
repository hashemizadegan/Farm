"use client";
import { Notice, ProvenanceBadge } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";

export default function AssetsPage() {
  return (
    <>
      <h1>Asset catalogue</h1>
      <p className="mf-muted">Models and procedural shapes used to draw the 3D scene. All are illustrative.</p>
      <RequireTenant>{(tenantId) => <Catalog tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

function Catalog({ tenantId }: { tenantId: string }) {
  const assets = useQuery(`assets:${tenantId}`, () => unwrap(api.GET("/v1/tenants/{tenantId}/assets", { params: { path: { tenantId } } })));
  if (assets.loading) return <p role="status">Loading catalogue…</p>;
  if (assets.error) return <Notice tone="error">{assets.error.message}</Notice>;
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Kind</th>
          <th scope="col">Scope</th>
          <th scope="col">Licence</th>
          <th scope="col">Provenance</th>
        </tr>
      </thead>
      <tbody>
        {assets.data!.items.map((a) => (
          <tr key={a.id}>
            <th scope="row">{a.name}</th>
            <td>{a.kind}</td>
            <td>{a.scope}</td>
            <td>{a.license}</td>
            <td>
              <ProvenanceBadge label={a.provenance} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
