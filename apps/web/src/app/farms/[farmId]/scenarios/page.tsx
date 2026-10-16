"use client";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, ErrorSummary, Notice, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";

export default function ScenariosPage() {
  const { farmId } = useParams<{ farmId: string }>();
  return (
    <>
      <h1>Crop scenarios</h1>
      <Notice tone="warning" title="Simulation only.">
        Scenarios calculate low, base and high cases from the figures <em>you</em> enter. The application provides no yield, price or cost
        data. Results are not forecasts, not realised income, and not an offer or promise of any return.
      </Notice>
      <RequireTenant>{(tenantId) => <Scenarios tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}

type Range = { low: string; base: string; high: string };
const emptyRange = (): Range => ({ low: "", base: "", high: "" });

function Scenarios({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const announce = useAnnounce();
  const list = useQuery(`scenarios:${farmId}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/scenarios", { params: { path: { tenantId, farmId } } })),
  );
  const [cropName, setCropName] = useState("");
  const [area, setArea] = useState("");
  const [yieldUnit, setYieldUnit] = useState("t");
  const [currency, setCurrency] = useState("USD");
  const [yieldR, setYield] = useState<Range>(emptyRange);
  const [priceR, setPrice] = useState<Range>(emptyRange);
  const [costR, setCost] = useState<Range>(emptyRange);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const toRange = (r: Range) => ({ low: Number(r.low), base: Number(r.base), high: Number(r.high) });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problems: { message: string }[] = [];
    if (!cropName.trim()) problems.push({ message: "Enter a crop name." });
    for (const [label, r] of [["Yield", yieldR], ["Price", priceR], ["Costs", costR]] as const) {
      const v = toRange(r);
      if ([r.low, r.base, r.high].some((x) => x === "") || Object.values(v).some((n) => !Number.isFinite(n) || n < 0)) {
        problems.push({ message: `${label}: enter non-negative numbers for low, base and high.` });
      } else if (!(v.low <= v.base && v.base <= v.high)) {
        problems.push({ message: `${label}: low must not exceed base, and base must not exceed high.` });
      }
    }
    if (!/^[A-Z]{3}$/.test(currency)) problems.push({ message: "Currency must be a three-letter ISO code such as USD." });
    setErrors(problems);
    if (problems.length) return announce(`${problems.length} problem(s) found.`, "assertive");

    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/tenants/{tenantId}/farms/{farmId}/scenarios", {
          params: { path: { tenantId, farmId } },
          body: {
            cropName: cropName.trim(),
            plantedAreaHa: area ? Number(area) : undefined,
            yieldPerHa: toRange(yieldR),
            yieldUnit,
            pricePerUnit: toRange(priceR),
            costs: toRange(costR),
            currency,
            assumptionsNote: note || undefined,
          },
        }),
      );
      announce("Simulation saved.");
      list.reload();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid-2">
      <form onSubmit={submit} noValidate className="card" aria-labelledby="new-scenario">
        <h2 id="new-scenario">New simulation</h2>
        <ErrorSummary errors={errors} />
        <TextField label="Crop name" value={cropName} onChange={(e) => setCropName(e.target.value)} required />
        <TextField label="Planted area (ha)" hint="Leave blank to use the validated boundary area." inputMode="decimal" value={area} onChange={(e) => setArea(e.target.value)} />
        <TextField label="Yield unit" hint="e.g. t, kg, bushel" value={yieldUnit} onChange={(e) => setYieldUnit(e.target.value)} />
        <TextField label="Currency (ISO 4217)" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
        <RangeInputs legend="Yield per hectare (your estimate)" value={yieldR} onChange={setYield} />
        <RangeInputs legend="Price per yield unit (your estimate)" value={priceR} onChange={setPrice} />
        <RangeInputs legend="Total season costs (your estimate)" value={costR} onChange={setCost} />
        <TextField label="Where do these figures come from?" hint="Optional note, stored with the scenario." value={note} onChange={(e) => setNote(e.target.value)} />
        <Button type="submit" variant="primary" busy={busy}>
          Run simulation
        </Button>
      </form>

      <section aria-labelledby="saved-scenarios">
        <h2 id="saved-scenarios">Saved simulations</h2>
        {list.loading && <p role="status">Loading…</p>}
        {list.data?.items.length === 0 && <p>No simulations yet.</p>}
        {list.data?.items.map((s) => <ScenarioResult key={s.id} s={s} />)}
      </section>
    </div>
  );
}

function RangeInputs({ legend, value, onChange }: { legend: string; value: Range; onChange: (r: Range) => void }) {
  return (
    <fieldset className="range-row">
      <legend>{legend}</legend>
      {(["low", "base", "high"] as const).map((k) => (
        <TextField key={k} label={k[0]!.toUpperCase() + k.slice(1)} inputMode="decimal" value={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />
      ))}
    </fieldset>
  );
}

function ScenarioResult({ s }: { s: Schemas["CropScenario"] }) {
  const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: s.result.currency, maximumFractionDigits: 0 });
  return (
    <article className="card" style={{ marginBottom: "1rem" }}>
      <h3>
        {s.input.cropName} — <span className="mf-badge">Simulated</span>
      </h3>
      <table>
        <caption>
          Simulated cases for {s.input.plantedAreaHa?.toFixed(2)} ha, {new Date(s.createdAt).toLocaleDateString()}
        </caption>
        <thead>
          <tr>
            <th scope="col">Case</th>
            <th scope="col">Production ({s.result.yieldUnit})</th>
            <th scope="col">Gross (simulated)</th>
            <th scope="col">Costs</th>
            <th scope="col">Net (simulated)</th>
          </tr>
        </thead>
        <tbody>
          {(["low", "base", "high"] as const).map((k) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{s.result.cases[k].production}</td>
              <td>{fmt.format(s.result.cases[k].grossRevenue)}</td>
              <td>{fmt.format(s.result.cases[k].costs)}</td>
              <td>{fmt.format(s.result.cases[k].net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mf-muted">{s.result.disclaimer}</p>
    </article>
  );
}
