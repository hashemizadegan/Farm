"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { EQUIPMENT_KINDS, type EquipmentKind } from "@metafarm/domain";
import { Button, EmptyState, ErrorSummary, Notice, PageHeader, SelectField, StatusPill, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";
import { dueTone } from "@/lib/equipment";

export default function EquipmentPage() {
  const t = useI18n().m.equipment;
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <RequireTenant>{(tenantId) => <EquipmentList tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

function EquipmentList({ tenantId }: { tenantId: string }) {
  const { m, fmt } = useI18n();
  const t = m.equipment;
  const can = useCan();
  const [version, setVersion] = useState(0);
  const list = useQuery(`equipment:${tenantId}:${version}`, () => unwrap(api.GET("/v1/tenants/{tenantId}/equipment", { params: { path: { tenantId } } })));
  const items = list.data?.items ?? [];

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
          {items.map((e) => (
            <li key={e.id}>
              <article className="task" data-status={e.status === "retired" ? "cancelled" : "todo"} aria-labelledby={`eq-${e.id}`}>
                <div className="task__head">
                  <h2 id={`eq-${e.id}`} className="task__title">
                    <Link href={`/equipment/${e.id}`}>{e.name}</Link>
                  </h2>
                  <span className="task__status">
                    {e.status !== "active" && <StatusPill tone={e.status === "out_of_service" ? "problem" : "neutral"}>{t.statuses[e.status]}</StatusPill>}
                    {e.status !== "retired" && <StatusPill tone={dueTone(e.maintenance.state)}>{t.due[e.maintenance.state]}</StatusPill>}
                  </span>
                </div>
                <p className="task__meta">
                  {[t.kinds[e.kind], e.makeModel, e.farmName ?? t.noFarm, e.currentHours ? t.hours(fmt.number(Number(e.currentHours))) : null].filter(Boolean).join(" · ")}
                </p>
                {e.statusNote && e.status !== "active" && <p className="task__notes">{e.statusNote}</p>}
              </article>
            </li>
          ))}
        </ul>
      )}
      {can("equipment:manage") && <AddMachine tenantId={tenantId} onAdded={() => setVersion((v) => v + 1)} />}
    </>
  );
}

function AddMachine({ tenantId, onAdded }: { tenantId: string; onAdded: () => void }) {
  const { m } = useI18n();
  const t = m.equipment.form;
  const announce = useAnnounce();
  const farms = useQuery(`farms:${tenantId}:equipment-form`, () => unwrap(api.GET("/v1/tenants/{tenantId}/farms", { params: { path: { tenantId }, query: { limit: 100 } } })));
  const [name, setName] = useState("");
  const [kind, setKind] = useState<EquipmentKind>("tractor");
  const [makeModel, setMakeModel] = useState("");
  const [serial, setSerial] = useState("");
  const [farmId, setFarmId] = useState("");
  const [tracksHours, setTracksHours] = useState(true);
  const [hours, setHours] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const h = hours.trim().replace(",", ".");
    const p: { field?: string; message: string }[] = [];
    if (!name.trim()) p.push({ field: "eq-name", message: t.nameRequired });
    if (tracksHours && h && !/^\d{1,7}(\.\d)?$/.test(h)) p.push({ field: "eq-hours", message: t.hoursInvalid });
    setErrors(p);
    if (p.length) return;
    setBusy(true);
    try {
      const created = await unwrap(
        api.POST("/v1/tenants/{tenantId}/equipment", {
          params: { path: { tenantId } },
          body: {
            name: name.trim(),
            kind,
            makeModel: makeModel.trim() || null,
            serial: serial.trim() || null,
            farmId: farmId || null,
            tracksHours,
            currentHours: tracksHours && h ? h : null,
            notes: notes.trim() || null,
          },
        }),
      );
      announce(t.added(created.name));
      setName("");
      setMakeModel("");
      setSerial("");
      setHours("");
      setNotes("");
      onAdded();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  const err = (f: string) => errors.find((x) => x.field === f)?.message;
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="eq-form-heading" style={{ marginTop: "1.5rem" }}>
      <h2 id="eq-form-heading" style={{ marginTop: 0 }}>
        {t.heading}
      </h2>
      <ErrorSummary errors={errors} />
      <div className="grid-2">
        <TextField id="eq-name" label={t.name} hint={t.nameHint} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} error={err("eq-name")} />
        <SelectField label={t.kind} value={kind} onChange={(e) => setKind(e.target.value as EquipmentKind)}>
          {EQUIPMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {m.equipment.kinds[k]}
            </option>
          ))}
        </SelectField>
        <TextField label={t.makeModel} value={makeModel} maxLength={120} onChange={(e) => setMakeModel(e.target.value)} />
        <TextField label={t.serial} value={serial} maxLength={80} onChange={(e) => setSerial(e.target.value)} />
        <SelectField label={t.farm} value={farmId} onChange={(e) => setFarmId(e.target.value)}>
          <option value="">{t.noFarm}</option>
          {(farms.data?.items ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </SelectField>
        <div className="mf-field checkbox-field">
          <input id="eq-tracks" type="checkbox" checked={tracksHours} onChange={(e) => setTracksHours(e.target.checked)} />
          <label htmlFor="eq-tracks">{t.tracksHours}</label>
        </div>
        {tracksHours && <TextField id="eq-hours" label={t.currentHours} inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} error={err("eq-hours")} />}
      </div>
      <TextField label={t.notes} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
      <Button type="submit" variant="primary" busy={busy}>
        {t.submit}
      </Button>
    </form>
  );
}
