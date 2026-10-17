"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, EmptyState, ErrorSummary, Notice, SelectField, StatusPill, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";
import { localToday } from "@/lib/dates";
import { seasonTone } from "@/lib/seasons";

export default function SeasonsPage() {
  const { farmId } = useParams<{ farmId: string }>();
  const t = useI18n().m.seasons;
  return (
    <>
      <h1>{t.title}</h1>
      <p className="mf-hint">{t.intro}</p>
      <RequireTenant>{(tenantId) => <Seasons tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function Seasons({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const { m, fmt } = useI18n();
  const t = m.seasons;
  const can = useCan();
  const [version, setVersion] = useState(0);
  const list = useQuery(`seasons:${farmId}:${version}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/seasons", { params: { path: { tenantId, farmId } } })),
  );
  const items = list.data?.items ?? [];
  const today = localToday();

  return (
    <>
      {list.loading && !list.data && <p role="status">{t.loading}</p>}
      {list.error && (
        <Notice tone="error" title={t.couldNotLoad}>
          {list.error.message}
        </Notice>
      )}
      {list.data && items.length === 0 && <EmptyState title={t.none} />}
      {items.length > 0 && (
        <ul className="tasks">
          {items.map((s) => (
            <li key={s.id}>
              <SeasonCard s={s} farmId={farmId} today={today} fmtDay={fmt.day} />
            </li>
          ))}
        </ul>
      )}
      {can("plan:write") && <SeasonForm tenantId={tenantId} farmId={farmId} onCreated={() => setVersion((v) => v + 1)} />}
    </>
  );
}

function SeasonCard({ s, farmId, today, fmtDay }: { s: Schemas["Season"]; farmId: string; today: string; fmtDay: (d: string) => string }) {
  const t = useI18n().m.seasons;
  const age = daysBetween(s.plannedStart, today);
  return (
    <article className="task" aria-labelledby={`season-${s.id}`}>
      <div className="task__head">
        <h2 id={`season-${s.id}`} className="task__title">
          <Link href={`/farms/${farmId}/seasons/${s.id}`}>
            {s.cropName}
            {s.variety ? ` · ${s.variety}` : ""}
          </Link>
        </h2>
        <StatusPill tone={seasonTone(s.status)}>{t.statuses[s.status]}</StatusPill>
      </div>
      <p className="task__meta">
        {[
          s.parcelLabel ?? t.wholeFarm,
          t.started(fmtDay(s.plannedStart)),
          s.status === "active" && age >= 0 ? t.day(age + 1) : null,
          s.status === "closed" && s.endedOn ? t.ended(fmtDay(s.endedOn)) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <p className="task__notes">
        {s.currentStage && s.currentStageOn ? t.stageSince(t.stages[s.currentStage], fmtDay(s.currentStageOn)) : t.noStage}
        {s.status !== "closed" && s.expectedHarvestFrom ? ` · ${t.expected(fmtDay(s.expectedHarvestFrom))}` : ""}
      </p>
    </article>
  );
}

function SeasonForm({ tenantId, farmId, onCreated }: { tenantId: string; farmId: string; onCreated: () => void }) {
  const t = useI18n().m.seasons.form;
  const announce = useAnnounce();
  const plan = useQuery(`plan:${farmId}:labels`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/plan", { params: { path: { tenantId, farmId } } })).catch(() => null),
  );
  const parcels = plan.data?.parcels ?? [];
  const [crop, setCrop] = useState("");
  const [variety, setVariety] = useState("");
  const [parcel, setParcel] = useState("");
  const [area, setArea] = useState("");
  const [start, setStart] = useState(localToday());
  const [expected, setExpected] = useState("");
  const [status, setStatus] = useState<"active" | "planned">("active");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  function pickParcel(label: string) {
    setParcel(label);
    const p = parcels.find((x) => x.label === label);
    if (p?.cropName && !crop) setCrop(p.cropName);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const a = area.trim().replace(",", ".");
    const p: { field?: string; message: string }[] = [];
    if (!crop.trim()) p.push({ field: "season-crop", message: t.cropRequired });
    if (a && !(/^\d{1,7}(\.\d{1,4})?$/.test(a) && Number(a) > 0)) p.push({ field: "season-area", message: t.areaInvalid });
    setErrors(p);
    if (p.length) return;
    setBusy(true);
    try {
      const s = await unwrap(
        api.POST("/v1/tenants/{tenantId}/farms/{farmId}/seasons", {
          params: { path: { tenantId, farmId } },
          body: {
            cropName: crop.trim(),
            variety: variety.trim() || null,
            parcelLabel: parcel.trim() || null,
            areaHa: a || null,
            plannedStart: start,
            expectedHarvestFrom: expected || null,
            status,
            notes: notes.trim() || null,
          },
        }),
      );
      announce(t.created(s.cropName));
      setCrop("");
      setVariety("");
      setParcel("");
      setArea("");
      setExpected("");
      setNotes("");
      onCreated();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  const err = (f: string) => errors.find((x) => x.field === f)?.message;
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="season-form-heading" style={{ marginTop: "1.5rem" }}>
      <h2 id="season-form-heading" style={{ marginTop: 0 }}>
        {t.heading}
      </h2>
      <ErrorSummary errors={errors} />
      <div className="grid-2">
        <TextField label={t.parcel} hint={t.parcelHint} list="season-parcels" value={parcel} maxLength={80} onChange={(e) => pickParcel(e.target.value)} />
        <datalist id="season-parcels">
          {parcels.map((p) => (
            <option key={p.label} value={p.label} />
          ))}
        </datalist>
        <TextField id="season-crop" label={t.crop} value={crop} maxLength={120} onChange={(e) => setCrop(e.target.value)} error={err("season-crop")} />
        <TextField label={t.variety} value={variety} maxLength={120} onChange={(e) => setVariety(e.target.value)} />
        <TextField id="season-area" label={t.area} hint={t.areaHint} inputMode="decimal" value={area} onChange={(e) => setArea(e.target.value)} error={err("season-area")} />
        <TextField label={t.start} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <TextField label={t.expected} type="date" value={expected} min={start} onChange={(e) => setExpected(e.target.value)} />
        <SelectField label={t.status} value={status} onChange={(e) => setStatus(e.target.value as "active" | "planned")}>
          <option value="active">{t.active}</option>
          <option value="planned">{t.planned}</option>
        </SelectField>
      </div>
      <TextField label={t.notes} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} />
      <Button type="submit" variant="primary" busy={busy}>
        {t.submit}
      </Button>
    </form>
  );
}
