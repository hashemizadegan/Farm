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
import { useI18n } from "@/i18n/provider";

export default function BoundaryReviewPage() {
  const { farmId } = useParams<{ farmId: string }>();
  const { m } = useI18n();
  return (
    <>
      <h1>{m.boundary.title}</h1>
      <RequireTenant>{(tenantId) => <Review tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}

function Review({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const announce = useAnnounce();
  const can = useCan();
  const { m, fmt } = useI18n();
  const t = m.boundary;
  const statusText = (s: string) => t.status[s] ?? s;
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
      announce(t.statusChanged(latest.version, t.statusShort[latest.validationStatus] ?? latest.validationStatus));
    }
    prevStatus.current = latest?.validationStatus;
  }, [latest, announce, t]);

  if (versions.loading && !versions.data) return <p role="status">{t.loading}</p>;
  if (versions.error) return <Notice tone="error" title={t.couldNotLoad}>{versions.error.message}</Notice>;
  if (!latest) return <p>{t.none}</p>;

  const ring = (latest.geojson as unknown as BoundaryGeometry).type === "MultiPolygon"
    ? (latest.geojson as { coordinates: number[][][][] }).coordinates[0]![0]!
    : (latest.geojson as { coordinates: number[][][] }).coordinates[0]!;

  return (
    <>
      <div className="grid-2">
        <BoundaryMap label={t.mapLabel(latest.version)} boundary={latest.geojson as unknown as BoundaryGeometry} />
        <section className="card" aria-labelledby="latest-heading">
          <h2 id="latest-heading">{t.version(latest.version)}</h2>
          <dl>
            <dt>{t.validation}</dt>
            <dd data-testid="validation-status">{statusText(latest.validationStatus)}</dd>
            <dt>{t.provenance}</dt>
            <dd>
              <ProvenanceBadge label={latest.provenance} />
            </dd>
            <dt>{t.area}</dt>
            <dd>{t.areaValue(`${fmt.fixed(latest.areaM2 / 10_000, 3)} ${fmt.unitHa}`, fmt.m2(latest.areaM2))}</dd>
            <dt>{t.vertices}</dt>
            <dd>{fmt.number(latest.vertexCount)}</dd>
            <dt>{t.source}</dt>
            <dd>{t.sources[latest.source] ?? latest.source}</dd>
            <dt>{t.crs}</dt>
            <dd>
              <span className="ltr">{latest.crs}</span> {t.crsNote}
            </dd>
          </dl>
          {latest.validationIssues.length > 0 && (
            <Notice tone="error" title={t.problemsTitle}>
              <ul>
                {latest.validationIssues.map((i, n) => (
                  <li key={n}>{m.geometryIssue(i)}</li>
                ))}
              </ul>
            </Notice>
          )}
          {latest.overlaps && latest.overlaps.length > 0 && (
            <Notice tone="warning" title={t.overlapTitle}>
              {t.overlap(latest.overlaps.length)}
            </Notice>
          )}
        </section>
      </div>

      {can("boundary:verify") && latest.validationStatus === "valid" && latest.provenance !== "independently-verified" && (
        <VerifyPanel tenantId={tenantId} farmId={farmId} boundaryId={latest.id} version={latest.version} onVerified={versions.reload} />
      )}

      <details style={{ marginTop: "1rem" }}>
        <summary>{t.coordsSummary(ring.length - 1)}</summary>
        <table>
          <caption className="mf-visually-hidden">{t.coordsCaption(latest.version)}</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{t.lat}</th>
              <th scope="col">{t.lon}</th>
            </tr>
          </thead>
          <tbody>
            {ring.slice(0, -1).map(([lo, la], i) => (
              <tr key={i}>
                <td>{fmt.number(i + 1)}</td>
                <td className="ltr">{la!.toFixed(7)}</td>
                <td className="ltr">{lo!.toFixed(7)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <h2>{t.history}</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">{t.colVersion}</th>
            <th scope="col">{t.colStatus}</th>
            <th scope="col">{t.colProvenance}</th>
            <th scope="col">{t.colSubmitted}</th>
          </tr>
        </thead>
        <tbody>
          {versions.data!.items.map((v) => (
            <tr key={v.id}>
              <td>{fmt.number(v.version)}</td>
              <td>{statusText(v.validationStatus)}</td>
              <td>
                <ProvenanceBadge label={v.provenance} />
              </td>
              <td>
                <time dateTime={v.submittedAt}>{fmt.dateTime(v.submittedAt)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

const EVIDENCE_KINDS = ["survey-document", "registry-extract", "field-inspection", "other"] as const;

/**
 * Verifier workflow: attach one evidence document (an existing one from the
 * farm's files, or a new upload) to this boundary version. Only then does the
 * boundary become independently verified; the API records who did it.
 */
function VerifyPanel(props: { tenantId: string; farmId: string; boundaryId: string; version: number; onVerified: () => void }) {
  const { tenantId, farmId, boundaryId, version, onVerified } = props;
  const announce = useAnnounce();
  const t = useI18n().m.boundary.verify;
  const [kind, setKind] = useState<(typeof EVIDENCE_KINDS)[number]>("survey-document");
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
      setErrors([{ field: "evidence-file", message: t.chooseRequired }]);
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
      announce(t.verified(version));
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
      <h2 id="verify-heading">{t.heading}</h2>
      <p className="mf-hint">{t.intro}</p>
      <ErrorSummary errors={errors} />
      <FileUploader
        tenantId={tenantId}
        farmId={farmId}
        purpose="verification-evidence"
        label={t.upload}
        multiple={false}
        onUploaded={(m) => {
          setReloadKey((k) => k + 1);
          if (m[0]) setMediaId(m[0].id);
        }}
      />
      <form onSubmit={submit} noValidate>
        <SelectField
          id="evidence-file"
          label={t.document}
          value={mediaId}
          onChange={(e) => setMediaId(e.target.value)}
          error={errors.find((x) => x.field === "evidence-file")?.message}
        >
          <option value="">{items.length ? t.choose : t.uploadFirst}</option>
          {items.map((m) => (
            <option key={m.id} value={m.id}>
              {m.filename}
            </option>
          ))}
        </SelectField>
        <SelectField label={t.kind} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {EVIDENCE_KINDS.map((id) => (
            <option key={id} value={id}>
              {t.kinds[id]}
            </option>
          ))}
        </SelectField>
        <TextField label={t.note} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        <Button type="submit" variant="primary" busy={busy}>
          {t.submit}
        </Button>
      </form>
    </section>
  );
}
