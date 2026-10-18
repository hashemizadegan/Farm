"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, EmptyState, ErrorSummary, Notice, StatusPill, TextField, useAnnounce } from "@metafarm/ui";
import { HarvestLabel } from "@/components/HarvestLabel";
import { RequireTenant } from "@/components/RequireTenant";
import { ExportPanel } from "@/components/ExportPanel";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";
import { localToday } from "@/lib/dates";

type Harvest = Schemas["Harvest"];

export default function HarvestsPage() {
  const { farmId } = useParams<{ farmId: string }>();
  const t = useI18n().m.harvests;
  return (
    <>
      <h1>{t.title}</h1>
      <p className="mf-hint">{t.intro}</p>
      <RequireTenant>{(tenantId) => <Harvests tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}

function Harvests({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const t = useI18n().m.harvests;
  const can = useCan();
  const [version, setVersion] = useState(0);
  const list = useQuery(
    `harvests:${farmId}:${version}`,
    () => unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/harvests", { params: { path: { tenantId, farmId } } })),
    { pollMs: 8_000 },
  );
  const farm = useQuery(`farm:${farmId}:name`, () => unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}", { params: { path: { tenantId, farmId } } })));
  const reload = () => setVersion((v) => v + 1);
  const items = list.data?.items ?? [];

  return (
    <>
      {can("harvest:record") && <HarvestForm tenantId={tenantId} farmId={farmId} onRecorded={reload} />}
      {list.loading && !list.data && <p role="status">{t.loading}</p>}
      {list.error && (
        <Notice tone="error" title={t.couldNotLoad}>
          {list.error.message}
        </Notice>
      )}
      {list.data && items.length === 0 && <EmptyState title={t.none} />}
      {items.length > 0 && <ExportPanel tenantId={tenantId} farmId={farmId} datasets={["harvests"]} />}
      {items.length > 0 && (
        <ul className="tasks" style={{ marginTop: "1.5rem" }}>
          {items.map((h) => (
            <li key={h.id}>
              <HarvestCard h={h} tenantId={tenantId} farmName={farm.data?.name ?? ""} onChanged={reload} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function anchorTone(status: string, voided: boolean): "ok" | "pending" | "problem" | "neutral" {
  if (voided) return "neutral";
  return status === "confirmed" ? "ok" : status === "failed" ? "problem" : status === "not_configured" ? "neutral" : "pending";
}

function HarvestCard({ h, tenantId, farmName, onChanged }: { h: Harvest; tenantId: string; farmName: string; onChanged: () => void }) {
  const { m, fmt } = useI18n();
  const t = m.harvests;
  const can = useCan();
  const announce = useAnnounce();
  const [showLabel, setShowLabel] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const path = { tenantId, farmId: h.farmId, batchId: h.id };
  const quantity = `${fmt.number(Number(h.quantity), { maximumFractionDigits: 3 })} ${h.unit}`;
  const meta = [h.cropName, fmt.day(h.harvestedOn), quantity, h.parcelLabel, h.qualityGrade].filter(Boolean);

  async function retry() {
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(api.POST("/v1/tenants/{tenantId}/farms/{farmId}/harvests/{batchId}/anchor", { params: { path } }));
      announce(t.retried);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitVoid(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) return setError(t.voidReasonRequired);
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(api.POST("/v1/tenants/{tenantId}/farms/{farmId}/harvests/{batchId}/void", { params: { path }, body: { reason: reason.trim() } }));
      announce(t.voidedAnnounce(h.code));
      setVoiding(false);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="task" data-status={h.voidedAt ? "cancelled" : "todo"} aria-labelledby={`batch-${h.id}`}>
      <div className="task__head">
        <h2 id={`batch-${h.id}`} className="task__title">
          {t.batch("")}
          <span className="harvest__code ltr">{h.code}</span>
        </h2>
        <span className="anchor-status">
          <StatusPill tone={anchorTone(h.anchor.status, Boolean(h.voidedAt))}>{h.voidedAt ? t.voided : (t.anchor[h.anchor.status] ?? h.anchor.status)}</StatusPill>
        </span>
      </div>
      <p className="task__meta">{meta.join(" · ")}</p>
      <p className="mf-hint">{h.recordedByName ? t.recordedBy(h.recordedByName, fmt.dateTime(h.createdAt)) : t.recordedAt(fmt.dateTime(h.createdAt))}</p>
      {h.voidedAt && <p className="task__notes">{t.voidedOn(fmt.day(h.voidedAt.slice(0, 10)), h.voidReason ?? "")}</p>}
      {h.notes && <p className="task__notes">{h.notes}</p>}
      {h.anchor.status === "failed" && h.anchor.error && <p className="mf-error">{h.anchor.error}</p>}
      {error && (
        <p className="mf-error" role="alert">
          {error}
        </p>
      )}

      {voiding ? (
        <form onSubmit={submitVoid} noValidate className="task__complete">
          <TextField label={t.voidReason} hint={t.voidReasonHint} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <div className="task__actions">
            <Button type="submit" variant="danger" busy={busy}>
              {t.voidConfirm}
            </Button>
            <Button onClick={() => setVoiding(false)}>{t.voidCancel}</Button>
          </div>
        </form>
      ) : (
        <div className="task__actions">
          <Button aria-expanded={showLabel} onClick={() => setShowLabel((s) => !s)}>
            {showLabel ? t.hideLabel : t.label}
            <span className="mf-visually-hidden">{t.actionsFor(h.code)}</span>
          </Button>
          <Link className="mf-button" href={`/verify/${h.code}`} target="_blank" rel="noopener">
            {t.publicPage}
            <span className="mf-visually-hidden">{t.actionsFor(h.code)}</span>
          </Link>
          {h.anchor.explorerUrl && (
            <a className="mf-button" href={h.anchor.explorerUrl} target="_blank" rel="noopener noreferrer">
              {t.viewTx}
              <span className="mf-visually-hidden">{t.actionsFor(h.code)}</span>
            </a>
          )}
          {can("harvest:manage") && !h.voidedAt && (h.anchor.status === "failed" || h.anchor.status === "not_configured") && (
            <Button busy={busy} onClick={retry}>
              {t.retry}
              <span className="mf-visually-hidden">{t.actionsFor(h.code)}</span>
            </Button>
          )}
          {can("harvest:manage") && !h.voidedAt && (
            <Button variant="danger" onClick={() => setVoiding(true)}>
              {t.void}
              <span className="mf-visually-hidden">{t.actionsFor(h.code)}</span>
            </Button>
          )}
        </div>
      )}
      {showLabel && <HarvestLabel code={h.code} crop={h.cropName} harvestedOn={h.harvestedOn} quantity={quantity} farm={farmName} />}
    </article>
  );
}

function HarvestForm({ tenantId, farmId, onRecorded }: { tenantId: string; farmId: string; onRecorded: () => void }) {
  const t = useI18n().m.harvests.form;
  const announce = useAnnounce();
  const plan = useQuery(`plan:${farmId}:labels`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/plan", { params: { path: { tenantId, farmId } } })).catch(() => null),
  );
  const [crop, setCrop] = useState("");
  const [parcel, setParcel] = useState("");
  const [date, setDate] = useState(localToday());
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("kg");
  const [grade, setGrade] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const parcels = plan.data?.parcels ?? [];
  const { fmt } = useI18n();
  // Products still inside their pre-harvest interval on this parcel and day: a warning, not a block (the label is the authority).
  const phi = useQuery(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `phi:${farmId}:${parcel.trim()}:${date}` : null, () =>
    unwrap(
      api.GET("/v1/tenants/{tenantId}/farms/{farmId}/phi", {
        params: { path: { tenantId, farmId }, query: { on: date, ...(parcel.trim() ? { parcel: parcel.trim() } : {}) } },
      }),
    ),
  );
  const phiItems = phi.data?.items ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = quantity.trim().replace(",", ".");
    const problems: { field?: string; message: string }[] = [];
    if (!crop.trim()) problems.push({ field: "harvest-crop", message: t.cropRequired });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push({ field: "harvest-date", message: t.dateRequired });
    if (!/^\d{1,11}(\.\d{1,3})?$/.test(q) || !(Number(q) > 0)) problems.push({ field: "harvest-quantity", message: t.quantityInvalid });
    if (!unit.trim()) problems.push({ field: "harvest-unit", message: t.unitRequired });
    setErrors(problems);
    if (problems.length) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-error-summary]")?.focus());
      return;
    }
    setBusy(true);
    try {
      const h = await unwrap(
        api.POST("/v1/tenants/{tenantId}/farms/{farmId}/harvests", {
          params: { path: { tenantId, farmId } },
          body: {
            cropName: crop.trim(),
            parcelLabel: parcel.trim() || null,
            harvestedOn: date,
            quantity: q,
            unit: unit.trim(),
            qualityGrade: grade.trim() || null,
            notes: notes.trim() || null,
          },
        }),
      );
      announce(t.recorded(h.code));
      setQuantity("");
      setGrade("");
      setNotes("");
      onRecorded();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  const err = (f: string) => errors.find((x) => x.field === f)?.message;
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="harvest-form-heading">
      <h2 id="harvest-form-heading" style={{ marginTop: 0 }}>
        {t.heading}
      </h2>
      <ErrorSummary errors={errors} />
      <div className="grid-2">
        <TextField id="harvest-crop" label={t.crop} list="harvest-crops" value={crop} maxLength={120} onChange={(e) => setCrop(e.target.value)} error={err("harvest-crop")} />
        <datalist id="harvest-crops">
          {[...new Set(parcels.map((p) => p.cropName).filter(Boolean))].map((c) => (
            <option key={c} value={c!} />
          ))}
        </datalist>
        <TextField label={t.parcel} list="harvest-parcels" value={parcel} maxLength={80} onChange={(e) => setParcel(e.target.value)} />
        <datalist id="harvest-parcels">
          {parcels.map((p) => (
            <option key={p.label} value={p.label} />
          ))}
        </datalist>
        <TextField id="harvest-date" label={t.harvestedOn} type="date" value={date} max={localToday()} onChange={(e) => setDate(e.target.value)} error={err("harvest-date")} />
        <TextField
          id="harvest-quantity"
          label={t.quantity}
          hint={t.quantityHint}
          inputMode="decimal"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          error={err("harvest-quantity")}
        />
        <TextField id="harvest-unit" label={t.unit} hint={t.unitHint} list="harvest-units" value={unit} maxLength={16} onChange={(e) => setUnit(e.target.value)} error={err("harvest-unit")} />
        <datalist id="harvest-units">
          {["kg", "t", "crate", "box", "bag"].map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
        <TextField label={t.grade} value={grade} maxLength={40} onChange={(e) => setGrade(e.target.value)} />
      </div>
      <div className="mf-field">
        <label htmlFor="harvest-notes">{t.notes}</label>
        <p id="harvest-notes-hint" className="mf-hint">
          {t.notesHint}
        </p>
        <textarea id="harvest-notes" aria-describedby="harvest-notes-hint" rows={2} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {phiItems.length > 0 && (
        <div className="phi-warning" role="status">
          <Notice tone="warning" title={t.phiTitle}>
            <ul>
              {phiItems.map((p) => (
                <li key={p.itemId}>{t.phiItem(p.itemName, fmt.day(p.appliedOn), fmt.day(p.harvestAllowedFrom))}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}
      <Notice>{t.published}</Notice>
      <Button type="submit" variant="primary" busy={busy}>
        {t.submit}
      </Button>
    </form>
  );
}
