"use client";
import { Notice, ProvenanceBadge } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";
import { useI18n } from "@/i18n/provider";

export default function AssetsPage() {
  const t = useI18n().m.assets;
  return (
    <>
      <h1>{t.title}</h1>
      <p className="mf-muted">{t.intro}</p>
      <RequireTenant>{(tenantId) => <Catalog tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

function Catalog({ tenantId }: { tenantId: string }) {
  const t = useI18n().m.assets;
  const assets = useQuery(`assets:${tenantId}`, () => unwrap(api.GET("/v1/tenants/{tenantId}/assets", { params: { path: { tenantId } } })));
  if (assets.loading) return <p role="status">{t.loading}</p>;
  if (assets.error) return <Notice tone="error">{assets.error.message}</Notice>;
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">{t.colName}</th>
          <th scope="col">{t.colKind}</th>
          <th scope="col">{t.colScope}</th>
          <th scope="col">{t.colLicence}</th>
          <th scope="col">{t.colProvenance}</th>
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
