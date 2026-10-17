"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button, ErrorSummary, TextField, useAnnounce } from "@metafarm/ui";
import { api, unwrap, useQuery } from "@/lib/api";
import { useI18n } from "@/i18n/provider";

interface ParcelDraft {
  label: string;
  cropName: string;
  rows: string;
  cols: string;
  spacingM: string;
}

const blank = (label: string): ParcelDraft => ({ label, cropName: "", rows: "10", cols: "10", spacingM: "2" });

/** Farm plan configuration: named parcels with an illustrative planting grid that drives the 3D scene. */
export function PlanEditor({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const announce = useAnnounce();
  const { m } = useI18n();
  const t = m.plan;
  const plan = useQuery(`plan:${farmId}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/plan", { params: { path: { tenantId, farmId } } })).catch((e: { status?: number }) => {
      if (e.status === 404) return null;
      throw e;
    }),
  );
  const [name, setName] = useState(t.defaultName);
  const [parcels, setParcels] = useState<ParcelDraft[]>(() => [blank(t.parcel(1))]);
  const [errors, setErrors] = useState<{ message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!plan.data) return;
    setName(plan.data.name);
    setParcels(
      plan.data.parcels.map((p) => ({
        label: p.label,
        cropName: p.cropName ?? "",
        rows: String(p.grid.rows),
        cols: String(p.grid.cols),
        spacingM: String(p.grid.spacingM),
      })),
    );
  }, [plan.data]);

  const update = (i: number, patch: Partial<ParcelDraft>) => setParcels((ps) => ps.map((p, n) => (n === i ? { ...p, ...patch } : p)));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const problems: { message: string }[] = [];
    const body = parcels.map((p, i) => {
      const rows = Number(p.rows);
      const cols = Number(p.cols);
      const spacingM = Number(p.spacingM);
      if (!p.label.trim()) problems.push({ message: t.errLabel(i + 1) });
      if (!Number.isInteger(rows) || rows < 1 || rows > 500) problems.push({ message: t.errRows(i + 1) });
      if (!Number.isInteger(cols) || cols < 1 || cols > 500) problems.push({ message: t.errCols(i + 1) });
      if (!(spacingM > 0 && spacingM <= 50)) problems.push({ message: t.errSpacing(i + 1) });
      return { label: p.label.trim(), cropName: p.cropName.trim() || undefined, grid: { rows, cols, spacingM } };
    });
    setErrors(problems);
    if (problems.length) return announce(t.problems(problems.length), "assertive");
    setBusy(true);
    try {
      await unwrap(api.PUT("/v1/tenants/{tenantId}/farms/{farmId}/plan", { params: { path: { tenantId, farmId } }, body: { name, parcels: body } }));
      announce(t.saved);
      plan.reload();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} noValidate className="card" aria-labelledby="plan-heading" style={{ marginTop: "1.5rem" }}>
      <h2 id="plan-heading">{t.heading}</h2>
      <p className="mf-hint">{t.intro((x) => <Link href={`/farms/${farmId}/scene`}>{x}</Link>)}</p>
      <ErrorSummary errors={errors} />
      <TextField label={t.name} value={name} onChange={(e) => setName(e.target.value)} />
      {parcels.map((p, i) => (
        <fieldset key={i}>
          <legend>{t.parcel(i + 1)}</legend>
          <div className="grid-2">
            <TextField label={t.label} value={p.label} onChange={(e) => update(i, { label: e.target.value })} />
            <TextField label={t.crop} value={p.cropName} onChange={(e) => update(i, { cropName: e.target.value })} />
            <TextField label={t.rows} type="number" min={1} max={500} value={p.rows} onChange={(e) => update(i, { rows: e.target.value })} />
            <TextField label={t.columns} type="number" min={1} max={500} value={p.cols} onChange={(e) => update(i, { cols: e.target.value })} />
            <TextField label={t.spacing} type="number" min={0.1} max={50} step={0.1} value={p.spacingM} onChange={(e) => update(i, { spacingM: e.target.value })} />
          </div>
          <Button variant="danger" onClick={() => setParcels((ps) => ps.filter((_, n) => n !== i))} disabled={parcels.length === 1}>
            {t.remove(i + 1)}
          </Button>
        </fieldset>
      ))}
      <Button onClick={() => setParcels((ps) => [...ps, blank(t.parcel(ps.length + 1))])}>{t.add}</Button>{" "}
      <Button type="submit" variant="primary" busy={busy}>
        {t.save}
      </Button>
    </form>
  );
}
