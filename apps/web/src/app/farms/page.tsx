"use client";
import Link from "next/link";
import { Notice } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";

export default function FarmsPage() {
  return (
    <>
      <h1>Farms</h1>
      <RequireTenant>{(tenantId) => <FarmList tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

function FarmList({ tenantId }: { tenantId: string }) {
  const farms = useQuery(`farms:${tenantId}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms", { params: { path: { tenantId }, query: { limit: 100 } } })),
  );
  return (
    <>
      <p>
        <Link href="/farms/new" className="mf-button mf-button--primary">
          Create a farm project
        </Link>
      </p>
      {farms.loading && <p role="status">Loading farms…</p>}
      {farms.error && <Notice tone="error" title="Could not load farms.">{farms.error.message}</Notice>}
      {farms.data && farms.data.items.length === 0 && <p>No farm projects yet.</p>}
      {farms.data && farms.data.items.length > 0 && (
        <table>
          <caption className="mf-visually-hidden">Your farm projects</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Boundary</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {farms.data.items.map((f) => (
              <tr key={f.id}>
                <th scope="row">
                  <Link href={`/farms/${f.id}`}>{f.name}</Link>
                </th>
                <td>{f.currentBoundaryVersionId ? "Validated boundary" : "No validated boundary yet"}</td>
                <td>
                  <time dateTime={f.createdAt}>{new Date(f.createdAt).toLocaleDateString()}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
