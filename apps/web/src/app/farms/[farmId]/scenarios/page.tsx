"use client";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, ErrorSummary, Notice, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useI18n } from "@/i18n/provider";

export default function ScenariosPage() {
  const { farmId } = useParams<{ farmId: string }>();
  const t = useI18n().m.scenarios;
  return (
    <>
      <h1>{t.title}</h1>
      <Notice tone="warning" title={t.simOnlyTitle}>
        {t.simOnly((x) => <em>{x}</em>)}
      </Notice>
      <RequireTenant>{(tenantId) => <Scenarios tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}

type Range = { low: string; base: string; high: string };
const emptyRange = (): Range => ({ low: "", base: "", high: "" });

function Scenarios({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const announce = useAnnounce();
  const { m } = useI18n();
  const t = m.scenarios;
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
    if (!cropName.trim()) problems.push({ message: t.errCrop });
    for (const [label, r] of [[t.yieldName, yieldR], [t.priceName, priceR], [t.costsName, costR]] as const) {
      const v = toRange(r);
      if ([r.low, r.base, r.high].some((x) => x === "") || Object.values(v).some((n) => !Number.isFinite(n) || n < 0)) {
        problems.push({ message: t.errNumbers(label) });
      } else if (!(v.low <= v.base && v.base <= v.high)) {
        problems.push({ message: t.errOrder(label) });
      }
    }
    if (!/^[A-Z]{3}$/.test(currency)) problems.push({ message: t.errCurrency });
    setErrors(problems);
    if (problems.length) return announce(m.common.problems(problems.length), "assertive");

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
      announce(t.saved);
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
        <h2 id="new-scenario">{t.newHeading}</h2>
        <ErrorSummary errors={errors} />
        <TextField label={t.crop} value={cropName} onChange={(e) => setCropName(e.target.value)} required />
        <TextField label={t.area} hint={t.areaHint} inputMode="decimal" value={area} onChange={(e) => setArea(e.target.value)} />
        <TextField label={t.yieldUnit} hint={t.yieldUnitHint} value={yieldUnit} onChange={(e) => setYieldUnit(e.target.value)} />
        <TextField label={t.currency} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
        <RangeInputs legend={t.yieldLegend} value={yieldR} onChange={setYield} />
        <RangeInputs legend={t.priceLegend} value={priceR} onChange={setPrice} />
        <RangeInputs legend={t.costLegend} value={costR} onChange={setCost} />
        <TextField label={t.note} hint={t.noteHint} value={note} onChange={(e) => setNote(e.target.value)} />
        <Button type="submit" variant="primary" busy={busy}>
          {t.run}
        </Button>
      </form>

      <section aria-labelledby="saved-scenarios">
        <h2 id="saved-scenarios">{t.savedHeading}</h2>
        {list.loading && <p role="status">{m.common.loading}</p>}
        {list.data?.items.length === 0 && <p>{t.none}</p>}
        {list.data?.items.map((s) => <ScenarioResult key={s.id} s={s} />)}
      </section>
    </div>
  );
}

function RangeInputs({ legend, value, onChange }: { legend: string; value: Range; onChange: (r: Range) => void }) {
  const cases = useI18n().m.scenarios.cases;
  return (
    <fieldset className="range-row">
      <legend>{legend}</legend>
      {(["low", "base", "high"] as const).map((k) => (
        <TextField key={k} label={cases[k]} inputMode="decimal" value={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />
      ))}
    </fieldset>
  );
}

function ScenarioResult({ s }: { s: Schemas["CropScenario"] }) {
  const { m, fmt } = useI18n();
  const t = m.scenarios;
  const money = (n: number) => fmt.currency(n, s.result.currency);
  return (
    <article className="card" style={{ marginBottom: "1rem" }}>
      <h3>
        {s.input.cropName} — <span className="mf-badge">{t.simulated}</span>
      </h3>
      <table>
        <caption>
          {t.caption(s.input.plantedAreaHa != null ? `${fmt.fixed(s.input.plantedAreaHa, 2)} ${fmt.unitHa}` : "—", fmt.date(s.createdAt))}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t.colCase}</th>
            <th scope="col">{t.colProduction(s.result.yieldUnit)}</th>
            <th scope="col">{t.colGross}</th>
            <th scope="col">{t.colCosts}</th>
            <th scope="col">{t.colNet}</th>
          </tr>
        </thead>
        <tbody>
          {(["low", "base", "high"] as const).map((k) => (
            <tr key={k}>
              <th scope="row">{t.cases[k]}</th>
              <td>{fmt.number(s.result.cases[k].production)}</td>
              <td>{money(s.result.cases[k].grossRevenue)}</td>
              <td>{money(s.result.cases[k].costs)}</td>
              <td>{money(s.result.cases[k].net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mf-muted">{t.disclaimer}</p>
    </article>
  );
}
