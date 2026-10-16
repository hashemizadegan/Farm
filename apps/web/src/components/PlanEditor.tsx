"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button, ErrorSummary, TextField, useAnnounce } from "@metafarm/ui";
import { api, unwrap, useQuery } from "@/lib/api";

interface ParcelDraft {
  label: string;
  cropName: string;
  rows: string;
  cols: string;
  spacingM: string;
}

const blank = (n: number): ParcelDraft => ({ label: `Parcel ${n}`, cropName: "", rows: "10", cols: "10", spacingM: "2" });

/** Farm plan configuration: named parcels with an illustrative planting grid that drives the 3D scene. */
export function PlanEditor({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const announce = useAnnounce();
  const plan = useQuery(`plan:${farmId}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/plan", { params: { path: { tenantId, farmId } } })).catch((e: { status?: number }) => {
      if (e.status === 404) return null;
      throw e;
    }),
  );
  const [name, setName] = useState("Main plan");
  const [parcels, setParcels] = useState<ParcelDraft[]>([blank(1)]);
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
      if (!p.label.trim()) problems.push({ message: `Parcel ${i + 1}: enter a label.` });
      if (!Number.isInteger(rows) || rows < 1 || rows > 500) problems.push({ message: `Parcel ${i + 1}: rows must be 1–500.` });
      if (!Number.isInteger(cols) || cols < 1 || cols > 500) problems.push({ message: `Parcel ${i + 1}: columns must be 1–500.` });
      if (!(spacingM > 0 && spacingM <= 50)) problems.push({ message: `Parcel ${i + 1}: spacing must be between 0 and 50 m.` });
      return { label: p.label.trim(), cropName: p.cropName.trim() || undefined, grid: { rows, cols, spacingM } };
    });
    setErrors(problems);
    if (problems.length) return announce(`${problems.length} problem(s) in the plan.`, "assertive");
    setBusy(true);
    try {
      await unwrap(api.PUT("/v1/tenants/{tenantId}/farms/{farmId}/plan", { params: { path: { tenantId, farmId } }, body: { name, parcels: body } }));
      announce("Plan saved.");
      plan.reload();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} noValidate className="card" aria-labelledby="plan-heading" style={{ marginTop: "1.5rem" }}>
      <h2 id="plan-heading">Planting plan</h2>
      <p className="mf-hint">
        Parcels and grids are your plan. The <Link href={`/farms/${farmId}/scene`}>3D scene</Link> draws an illustrative plant for each grid position inside the
        validated boundary.
      </p>
      <ErrorSummary errors={errors} />
      <TextField label="Plan name" value={name} onChange={(e) => setName(e.target.value)} />
      {parcels.map((p, i) => (
        <fieldset key={i}>
          <legend>Parcel {i + 1}</legend>
          <div className="grid-2">
            <TextField label="Label" value={p.label} onChange={(e) => update(i, { label: e.target.value })} />
            <TextField label="Crop (optional)" value={p.cropName} onChange={(e) => update(i, { cropName: e.target.value })} />
            <TextField label="Rows" type="number" min={1} max={500} value={p.rows} onChange={(e) => update(i, { rows: e.target.value })} />
            <TextField label="Columns" type="number" min={1} max={500} value={p.cols} onChange={(e) => update(i, { cols: e.target.value })} />
            <TextField label="Spacing (m)" type="number" min={0.1} max={50} step={0.1} value={p.spacingM} onChange={(e) => update(i, { spacingM: e.target.value })} />
          </div>
          <Button variant="danger" onClick={() => setParcels((ps) => ps.filter((_, n) => n !== i))} disabled={parcels.length === 1}>
            Remove parcel {i + 1}
          </Button>
        </fieldset>
      ))}
      <Button onClick={() => setParcels((ps) => [...ps, blank(ps.length + 1)])}>Add parcel</Button>{" "}
      <Button type="submit" variant="primary" busy={busy}>
        Save plan
      </Button>
    </form>
  );
}
