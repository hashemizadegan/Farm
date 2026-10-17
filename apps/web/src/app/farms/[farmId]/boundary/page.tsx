"use client";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BoundaryGeometry } from "@metafarm/domain/geometry";
import { Button, ErrorSummary, Notice, ProvenanceBadge, SelectField, TextField, useAnnounce } from "@metafarm/ui";
import { BoundaryMap } from "@/components/BoundaryMap";
import { FileUploader } from "@/components/FileUploader";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";

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
  const can = useCan();
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

      {can("boundary:verify") && latest.validationStatus === "valid" && latest.provenance !== "independently-verified" && (
        <VerifyPanel tenantId={tenantId} farmId={farmId} boundaryId={latest.id} version={latest.version} onVerified={versions.reload} />
      )}

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

const EVIDENCE_KINDS = [
  ["survey-document", "Survey document"],
  ["registry-extract", "Land registry extract"],
  ["field-inspection", "Field inspection report"],
  ["other", "Other"],
] as const;

/**
 * Verifier workflow: attach one evidence document (an existing one from the
 * farm's files, or a new upload) to this boundary version. Only then does the
 * boundary become independently verified; the API records who did it.
 */
function VerifyPanel(props: { tenantId: string; farmId: string; boundaryId: string; version: number; onVerified: () => void }) {
  const { tenantId, farmId, boundaryId, version, onVerified } = props;
  const announce = useAnnounce();
  const [kind, setKind] = useState<(typeof EVIDENCE_KINDS)[number][0]>("survey-document");
  const [mediaId, setMediaId] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const docs = useQuery(`media:${farmId}:verification-evidence:${reloadKey}`, () =>
    unwrap(
      api.GET("/v1/tenants/{tenantId}/farms/{farmId}/media", {
        params: { path: { tenantId, farmId }, query: { purpose: "verification-evidence" } },
      }),
    ),
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!mediaId) {
      setErrors([{ field: "evidence-file", message: "Choose or upload the evidence document." }]);
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      await unwrap(
        api.POST("/v1/tenants/{tenantId}/farms/{farmId}/boundaries/{boundaryId}/evidence", {
          params: { path: { tenantId, farmId, boundaryId } },
          body: { kind, mediaObjectId: mediaId, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      );
      announce(`Boundary version ${version} marked independently verified.`);
      onVerified();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  const items = docs.data?.items ?? [];
  return (
    <section className="card" aria-labelledby="verify-heading" style={{ marginTop: "1.5rem" }}>
      <h2 id="verify-heading">Verify this boundary</h2>
      <p className="mf-hint">
        You are a verifier in this workspace. Attach the document you checked this boundary against. The boundary is then
        labelled independently verified, with your name and the document on record.
      </p>
      <ErrorSummary errors={errors} />
      <FileUploader
        tenantId={tenantId}
        farmId={farmId}
        purpose="verification-evidence"
        label="Upload an evidence document"
        multiple={false}
        onUploaded={(m) => {
          setReloadKey((k) => k + 1);
          if (m[0]) setMediaId(m[0].id);
        }}
      />
      <form onSubmit={submit} noValidate>
        <SelectField
          id="evidence-file"
          label="Evidence document"
          value={mediaId}
          onChange={(e) => setMediaId(e.target.value)}
          error={errors.find((x) => x.field === "evidence-file")?.message}
        >
          <option value="">{items.length ? "Choose a document" : "Upload a document first"}</option>
          {items.map((m) => (
            <option key={m.id} value={m.id}>
              {m.filename}
            </option>
          ))}
        </SelectField>
        <SelectField label="Kind of evidence" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {EVIDENCE_KINDS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </SelectField>
        <TextField label="Note (optional)" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        <Button type="submit" variant="primary" busy={busy}>
          Mark as independently verified
        </Button>
      </form>
    </section>
  );
}
