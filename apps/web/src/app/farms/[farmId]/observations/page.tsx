"use client";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, ErrorSummary, Notice, ProvenanceBadge, SelectField, TextField, useAnnounce } from "@metafarm/ui";
import { FileList } from "@/components/FileList";
import { FileUploader } from "@/components/FileUploader";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";
import { useI18n } from "@/i18n/provider";

const METRICS = [
  ["soil_moisture", ["percent_vwc", "fraction_vwc"]],
  ["air_temperature", ["celsius", "fahrenheit", "kelvin"]],
  ["soil_temperature", ["celsius", "fahrenheit", "kelvin"]],
  ["rainfall", ["mm", "cm", "in"]],
  ["relative_humidity", ["percent", "fraction"]],
  ["ndvi", ["index"]],
  ["note", ["text"]],
] as const;

type Metric = (typeof METRICS)[number][0];

export default function ObservationsPage() {
  const { farmId } = useParams<{ farmId: string }>();
  const { m } = useI18n();
  return (
    <>
      <h1>{m.observations.title}</h1>
      <RequireTenant>
        {(tenantId) => (
          <>
            <Observations tenantId={tenantId} farmId={farmId} />
            <FieldPhotos tenantId={tenantId} farmId={farmId} />
          </>
        )}
      </RequireTenant>
    </>
  );
}

function Observations({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const announce = useAnnounce();
  const { m, fmt } = useI18n();
  const t = m.observations;
  const [metric, setMetric] = useState<Metric>("soil_moisture");
  const units = METRICS.find((x) => x[0] === metric)![1];
  const [unit, setUnit] = useState<string>(units[0]);
  const [value, setValue] = useState("");
  const [observedAt, setObservedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [errors, setErrors] = useState<{ message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const list = useQuery(`obs:${farmId}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/observations", { params: { path: { tenantId, farmId }, query: { limit: 100 } } })),
    { pollMs: 10_000 },
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const isNote = metric === "note";
    const v = isNote ? value.trim() : Number(value);
    if ((isNote && !v) || (!isNote && (value === "" || !Number.isFinite(v)))) {
      setErrors([{ message: isNote ? t.noteRequired : t.numberRequired }]);
      return;
    }
    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/tenants/{tenantId}/farms/{farmId}/observations", {
          params: { path: { tenantId, farmId } },
          body: { metric, value: v, unit, observedAt: new Date(observedAt).toISOString() },
        }),
      );
      setValue("");
      setErrors([]);
      announce(t.recorded);
      setTimeout(list.reload, 1_500);
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid-2">
      <form className="card" onSubmit={submit} noValidate aria-labelledby="obs-form">
        <h2 id="obs-form">{t.formHeading}</h2>
        <ErrorSummary errors={errors} />
        <SelectField
          label={t.measurement}
          value={metric}
          onChange={(e) => {
            const next = e.target.value as Metric;
            setMetric(next);
            setUnit(METRICS.find((x) => x[0] === next)![1][0]);
          }}
        >
          {METRICS.map(([id]) => (
            <option key={id} value={id}>
              {t.metrics[id]}
            </option>
          ))}
        </SelectField>
        <SelectField label={t.unit} value={unit} onChange={(e) => setUnit(e.target.value)}>
          {units.map((u) => (
            <option key={u} value={u}>
              {t.units[u] ?? u}
            </option>
          ))}
        </SelectField>
        <TextField label={metric === "note" ? t.note : t.value} inputMode={metric === "note" ? "text" : "decimal"} value={value} onChange={(e) => setValue(e.target.value)} />
        <TextField label={t.observedAt} type="datetime-local" value={observedAt} onChange={(e) => setObservedAt(e.target.value)} />
        <p className="mf-hint">{t.userEntered}</p>
        <Button type="submit" variant="primary" busy={busy}>
          {t.save}
        </Button>
      </form>

      <section aria-labelledby="obs-table">
        <h2 id="obs-table">{t.recentHeading}</h2>
        {list.error && <Notice tone="error">{list.error.message}</Notice>}
        {list.data?.items.length === 0 && <p>{t.none}</p>}
        {list.data && list.data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th scope="col">{t.colWhen}</th>
                <th scope="col">{t.colMeasurement}</th>
                <th scope="col">{t.colValue}</th>
                <th scope="col">{t.colSource}</th>
                <th scope="col">{t.colFlags}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <time dateTime={o.observedAt}>{fmt.dateTime(o.observedAt)}</time>
                  </td>
                  <td>{t.metrics[o.metric] ?? o.metric}</td>
                  <td>{o.value !== null ? `${fmt.number(o.value)} ${t.units[o.unit] ?? o.unit}` : o.text}</td>
                  <td>
                    <ProvenanceBadge label={o.provenance} />
                  </td>
                  <td>{o.qualityFlags.length ? fmt.list(o.qualityFlags.map((f) => t.flags[f] ?? f)) : m.common.none}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function FieldPhotos({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const can = useCan();
  const t = useI18n().m.observations;
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <section className="card" aria-labelledby="photos-heading" style={{ marginTop: "1.5rem" }}>
      <h2 id="photos-heading">{t.photosHeading}</h2>
      {can("media:upload") && (
        <FileUploader
          tenantId={tenantId}
          farmId={farmId}
          purpose="observation-photo"
          label={t.addPhotos}
          hint={t.photosHint}
          onUploaded={() => setReloadKey((k) => k + 1)}
        />
      )}
      <FileList tenantId={tenantId} farmId={farmId} purpose="observation-photo" reloadKey={reloadKey} emptyTitle={t.noPhotos} />
    </section>
  );
}
