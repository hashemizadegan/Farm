"use client";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, ErrorSummary, Notice, ProvenanceBadge, SelectField, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";

const METRICS = [
  ["soil_moisture", "Soil moisture", ["percent_vwc", "fraction_vwc"]],
  ["air_temperature", "Air temperature", ["celsius", "fahrenheit", "kelvin"]],
  ["soil_temperature", "Soil temperature", ["celsius", "fahrenheit", "kelvin"]],
  ["rainfall", "Rainfall", ["mm", "cm", "in"]],
  ["relative_humidity", "Relative humidity", ["percent", "fraction"]],
  ["ndvi", "NDVI", ["index"]],
  ["note", "Field note", ["text"]],
] as const;

type Metric = (typeof METRICS)[number][0];

export default function ObservationsPage() {
  const { farmId } = useParams<{ farmId: string }>();
  return (
    <>
      <h1>Observations</h1>
      <RequireTenant>{(tenantId) => <Observations tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}

function Observations({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const announce = useAnnounce();
  const [metric, setMetric] = useState<Metric>("soil_moisture");
  const units = METRICS.find((m) => m[0] === metric)![2];
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
      setErrors([{ message: isNote ? "Enter a note." : "Enter a numeric value." }]);
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
      announce("Observation recorded. It will appear in the table once processed.");
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
        <h2 id="obs-form">Record an observation</h2>
        <ErrorSummary errors={errors} />
        <SelectField
          label="Measurement"
          value={metric}
          onChange={(e) => {
            const m = e.target.value as Metric;
            setMetric(m);
            setUnit(METRICS.find((x) => x[0] === m)![2][0]);
          }}
        >
          {METRICS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </SelectField>
        <SelectField label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
          {units.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </SelectField>
        <TextField label={metric === "note" ? "Note" : "Value"} inputMode={metric === "note" ? "text" : "decimal"} value={value} onChange={(e) => setValue(e.target.value)} />
        <TextField label="Observed at (your local time)" type="datetime-local" value={observedAt} onChange={(e) => setObservedAt(e.target.value)} />
        <p className="mf-hint">Observations you enter are labelled user-entered.</p>
        <Button type="submit" variant="primary" busy={busy}>
          Save observation
        </Button>
      </form>

      <section aria-labelledby="obs-table">
        <h2 id="obs-table">Recent observations</h2>
        {list.error && <Notice tone="error">{list.error.message}</Notice>}
        {list.data?.items.length === 0 && <p>No observations recorded. This application does not generate readings.</p>}
        {list.data && list.data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Measurement</th>
                <th scope="col">Value</th>
                <th scope="col">Source</th>
                <th scope="col">Flags</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <time dateTime={o.observedAt}>{new Date(o.observedAt).toLocaleString()}</time>
                  </td>
                  <td>{o.metric}</td>
                  <td>{o.value !== null ? `${o.value} ${o.unit}` : o.text}</td>
                  <td>
                    <ProvenanceBadge label={o.provenance} />
                  </td>
                  <td>{o.qualityFlags.length ? o.qualityFlags.join(", ") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
