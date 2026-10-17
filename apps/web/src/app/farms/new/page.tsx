"use client";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { squareAround, validateBoundary, type BoundaryGeometry, type GeometryIssue } from "@metafarm/domain/geometry";
import { Button, ErrorSummary, Notice, TextField, useAnnounce } from "@metafarm/ui";
import { BoundaryMap } from "@/components/BoundaryMap";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap } from "@/lib/api";
import { useI18n } from "@/i18n/provider";

type Method = "coordinates" | "drawn" | "imported";
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export default function NewFarmPage() {
  const { m } = useI18n();
  return (
    <>
      <h1>{m.newFarm.title}</h1>
      <RequireTenant>{(tenantId) => <Onboarding tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

function Onboarding({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const announce = useAnnounce();
  const summaryRef = useRef<HTMLDivElement>(null);
  const { m, fmt } = useI18n();
  const t = m.newFarm;
  const issueToError = (i: GeometryIssue) => ({ message: m.geometryIssue(i) });

  const [name, setName] = useState("");
  const [method, setMethod] = useState<Method>("coordinates");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [sideM, setSideM] = useState("200");
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [imported, setImported] = useState<unknown>(null);
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  // If the farm was created but the boundary was rejected, retries reuse it instead of creating duplicates.
  const [createdFarmId, setCreatedFarmId] = useState<string>();

  const origin = useMemo<[number, number] | undefined>(() => {
    const la = Number(lat);
    const lo = Number(lon);
    return lat !== "" && lon !== "" && Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? [lo, la] : undefined;
  }, [lat, lon]);

  const geometry = useMemo<unknown>(() => {
    if (method === "coordinates" && origin) return squareAround(origin[0], origin[1], Number(sideM) / 2);
    if (method === "drawn" && draft.length >= 3) return { type: "Polygon", coordinates: [[...draft, draft[0]!]] };
    if (method === "imported") return imported;
    return null;
  }, [method, origin, sideM, draft, imported]);

  const preview = useMemo(() => (geometry ? validateBoundary(geometry) : null), [geometry]);

  const fail = (list: { field?: string; message: string }[]) => {
    setErrors(list);
    announce(m.common.problems(list.length), "assertive");
    requestAnimationFrame(() => summaryRef.current?.querySelector<HTMLElement>("[data-error-summary]")?.focus());
  };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return fail([{ field: "import", message: t.importTooBig }]);
    try {
      setImported(JSON.parse(await file.text()));
      setErrors([]);
      announce(t.fileLoaded);
    } catch {
      fail([{ field: "import", message: t.notJson }]);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problems: { field?: string; message: string }[] = [];
    if (!name.trim()) problems.push({ field: "farm-name", message: t.nameRequired });
    if (method === "coordinates" && !origin) problems.push({ field: "lat", message: t.latLonRequired });
    if (!geometry) problems.push({ message: t.boundaryRequired });
    if (preview && !preview.valid) problems.push(...preview.issues.map(issueToError));
    if (problems.length) return fail(problems);

    setBusy(true);
    try {
      let farmId = createdFarmId;
      if (!farmId) {
        const farm = await unwrap(
          api.POST("/v1/tenants/{tenantId}/farms", {
            params: { path: { tenantId } },
            body: { name: name.trim(), origin: origin ? { lon: origin[0], lat: origin[1] } : undefined },
          }),
        );
        farmId = farm.id;
        setCreatedFarmId(farmId);
      }
      await unwrap(
        api.POST("/v1/tenants/{tenantId}/farms/{farmId}/boundaries", {
          params: { path: { tenantId, farmId } },
          body: { geojson: geometry as Record<string, unknown>, source: method },
        }),
      );
      announce(t.created);
      router.push(`/farms/${farmId}/boundary`);
    } catch (err) {
      const body = (err as { body?: { details?: GeometryIssue[] } }).body;
      fail(Array.isArray(body?.details) ? body!.details.map(issueToError) : [{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <div ref={summaryRef}>
        <ErrorSummary errors={errors} />
      </div>
      <Notice>{t.notice((x) => <strong>{x}</strong>)}</Notice>

      <TextField id="farm-name" label={t.name} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />

      <fieldset>
        <legend>{t.methodLegend}</legend>
        {(["coordinates", "drawn", "imported"] as const).map((value) => (
          <div key={value}>
            <input type="radio" id={`method-${value}`} name="method" value={value} checked={method === value} onChange={() => setMethod(value)} />
            <label htmlFor={`method-${value}`}> {t.methods[value]}</label>
          </div>
        ))}
      </fieldset>

      {method === "coordinates" && (
        <div className="grid-2">
          <TextField id="lat" label={t.lat} hint={t.latHint} inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
          <TextField id="lon" label={t.lon} hint={t.lonHint} inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} />
          <TextField id="side" label={t.side} type="number" min={10} max={20000} value={sideM} onChange={(e) => setSideM(e.target.value)} />
        </div>
      )}

      {method === "drawn" && (
        <DrawPanel draft={draft} setDraft={setDraft} />
      )}

      {method === "imported" && (
        <div className="mf-field">
          <label htmlFor="import">{t.importLabel}</label>
          <input id="import" type="file" accept=".geojson,.json,application/geo+json,application/json" onChange={(e) => onImport(e.target.files?.[0])} />
        </div>
      )}

      <BoundaryMap
        label={t.mapLabel}
        center={origin}
        boundary={preview?.valid ? (preview.geometry as BoundaryGeometry) : null}
        draft={method === "drawn" ? draft : undefined}
        onAddVertex={method === "drawn" ? (p) => setDraft((d) => [...d, p]) : undefined}
      />

      <section aria-live="polite" className="card" style={{ margin: "1rem 0" }}>
        <h2>{t.checkHeading}</h2>
        {!preview && <p>{t.noBoundary}</p>}
        {preview?.valid && <p>{t.looksValid(preview.vertexCount, fmt.ha(preview.areaM2!))}</p>}
        {preview && !preview.valid && (
          <ul>
            {preview.issues.map((i, n) => (
              <li key={n}>{m.geometryIssue(i)}</li>
            ))}
          </ul>
        )}
      </section>

      <Button type="submit" variant="primary" busy={busy}>
        {t.submit}
      </Button>
    </form>
  );
}

function DrawPanel({ draft, setDraft }: { draft: [number, number][]; setDraft: (f: (d: [number, number][]) => [number, number][]) => void }) {
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const t = useI18n().m.newFarm;
  const add = () => {
    const la = Number(lat);
    const lo = Number(lon);
    if (lat === "" || lon === "" || !Number.isFinite(la) || !Number.isFinite(lo)) return;
    setDraft((d) => [...d, [lo, la]]);
    setLat("");
    setLon("");
  };
  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2>{t.cornersHeading}</h2>
      <p className="mf-hint">{t.cornersHint}</p>
      <div className="grid-2">
        <TextField label={t.cornerLat} inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
        <TextField label={t.cornerLon} inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} />
      </div>
      <Button onClick={add}>{t.addCorner}</Button>{" "}
      <Button onClick={() => setDraft((d) => d.slice(0, -1))} disabled={draft.length === 0}>
        {t.removeLast}
      </Button>{" "}
      <Button variant="danger" onClick={() => setDraft(() => [])} disabled={draft.length === 0}>
        {t.clear}
      </Button>
      <ol aria-label={t.cornersList} className="ltr">
        {draft.map(([lo, la], i) => (
          <li key={i}>
            {la.toFixed(6)}, {lo.toFixed(6)}
          </li>
        ))}
      </ol>
    </div>
  );
}
