"use client";
import { useParams } from "next/navigation";
import { useEffect, useRef } from "react";
import type { BoundaryGeometry } from "@metafarm/domain/geometry";
import { Notice, ProvenanceBadge, useAnnounce } from "@metafarm/ui";
import { BoundaryMap } from "@/components/BoundaryMap";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";

export default function BoundaryReviewPage() {
  const { farmId } = useParams<{ farmId: string }>();
  return (
    <>
      <h1>Boundary review</h1>
      <RequireTenant>{(tenantId) => <Review tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}

function Review({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const announce = useAnnounce();
  const versions = useQuery(
    `boundaries:${farmId}`,
    () => unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/boundaries", { params: { path: { tenantId, farmId } } })),
    // Poll while validation is pending; the GIS job usually finishes within seconds.
    { pollMs: 3_000 },
  );
  const latest = versions.data?.items[0];
  const prevStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (latest && prevStatus.current === "pending" && latest.validationStatus !== "pending") {
      announce(`Boundary version ${latest.version} is ${latest.validationStatus}.`);
    }
    prevStatus.current = latest?.validationStatus;
  }, [latest, announce]);

  if (versions.loading && !versions.data) return <p role="status">Loading boundary versions…</p>;
  if (versions.error) return <Notice tone="error" title="Could not load boundaries.">{versions.error.message}</Notice>;
  if (!latest) return <p>No boundary has been submitted for this farm.</p>;

  const ring = (latest.geojson as unknown as BoundaryGeometry).type === "MultiPolygon"
    ? (latest.geojson as { coordinates: number[][][][] }).coordinates[0]![0]!
    : (latest.geojson as { coordinates: number[][][] }).coordinates[0]!;

  return (
    <>
      <div className="grid-2">
        <BoundaryMap label={`Map of boundary version ${latest.version}`} boundary={latest.geojson as unknown as BoundaryGeometry} />
        <section className="card" aria-labelledby="latest-heading">
          <h2 id="latest-heading">Version {latest.version}</h2>
          <dl>
            <dt>Validation</dt>
            <dd data-testid="validation-status">{statusText(latest.validationStatus)}</dd>
            <dt>Provenance</dt>
            <dd>
              <ProvenanceBadge label={latest.provenance} />
            </dd>
            <dt>Area (geodesic estimate)</dt>
            <dd>
              {(latest.areaM2 / 10_000).toFixed(3)} ha ({Math.round(latest.areaM2).toLocaleString()} m²) — computed from the submitted shape, not a survey
            </dd>
            <dt>Vertices</dt>
            <dd>{latest.vertexCount}</dd>
            <dt>Source</dt>
            <dd>{latest.source}</dd>
            <dt>Coordinate reference</dt>
            <dd>{latest.crs} (WGS 84 longitude/latitude)</dd>
          </dl>
          {latest.validationIssues.length > 0 && (
            <Notice tone="error" title="Validation problems:">
              <ul>
                {latest.validationIssues.map((i, n) => (
                  <li key={n}>{i.message}</li>
                ))}
              </ul>
            </Notice>
          )}
          {latest.overlaps && latest.overlaps.length > 0 && (
            <Notice tone="warning" title="Overlap:">
              This boundary overlaps {latest.overlaps.length} other farm boundary(ies) in your workspace. Overlap is shown for review only.
            </Notice>
          )}
        </section>
      </div>

      <details style={{ marginTop: "1rem" }}>
        <summary>Boundary coordinates as text ({ring.length - 1} corners)</summary>
        <table>
          <caption className="mf-visually-hidden">Corner coordinates of boundary version {latest.version}</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Latitude</th>
              <th scope="col">Longitude</th>
            </tr>
          </thead>
          <tbody>
            {ring.slice(0, -1).map(([lo, la], i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{la!.toFixed(7)}</td>
                <td>{lo!.toFixed(7)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <h2>History</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Status</th>
            <th scope="col">Provenance</th>
            <th scope="col">Submitted</th>
          </tr>
        </thead>
        <tbody>
          {versions.data!.items.map((v) => (
            <tr key={v.id}>
              <td>{v.version}</td>
              <td>{statusText(v.validationStatus)}</td>
              <td>
                <ProvenanceBadge label={v.provenance} />
              </td>
              <td>
                <time dateTime={v.submittedAt}>{new Date(v.submittedAt).toLocaleString()}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function statusText(s: string) {
  return s === "pending" ? "Pending — validation in progress" : s === "valid" ? "Valid" : "Invalid";
}
