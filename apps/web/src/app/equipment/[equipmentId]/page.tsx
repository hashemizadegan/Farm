"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { EQUIPMENT_STATUSES } from "@metafarm/domain";
import { Button, ErrorSummary, Notice, SelectField, StatusPill, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";
import { localToday } from "@/lib/dates";
import { dueTone } from "@/lib/equipment";

type Detail = Schemas["EquipmentDetail"];

export default function MachinePage() {
  const { equipmentId } = useParams<{ equipmentId: string }>();
  return <RequireTenant>{(tenantId) => <Machine tenantId={tenantId} equipmentId={equipmentId} />}</RequireTenant>;
}

function Machine({ tenantId, equipmentId }: { tenantId: string; equipmentId: string }) {
  const { m, fmt } = useI18n();
  const t = m.equipment;
  const d = t.detail;
  const can = useCan();
  const [version, setVersion] = useState(0);
  const q = useQuery(`machine:${equipmentId}:${version}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/equipment/{equipmentId}", { params: { path: { tenantId, equipmentId } } })),
  );
  const reload = () => setVersion((v) => v + 1);
  if (q.loading && !q.data) return <p role="status">{t.loading}</p>;
  if (q.error) return <Notice tone="error" title={t.couldNotLoad}>{q.error.message}</Notice>;
  const { equipment: e, plans, readings, services } = q.data!;
  const h = (v: string | number) => t.hours(fmt.number(Number(v), { maximumFractionDigits: 1 }));

  return (
    <>
      <p>
        <Link href="/equipment">{d.back}</Link>
      </p>
      <div className="task__head">
        <h1 style={{ margin: 0 }}>{e.name}</h1>
        {e.status !== "active" && <StatusPill tone={e.status === "out_of_service" ? "problem" : "neutral"}>{t.statuses[e.status]}</StatusPill>}
      </div>
      <p className="mf-hint">
        {[t.kinds[e.kind], e.makeModel, e.serial, e.farmName ?? t.noFarm, e.currentHours ? h(e.currentHours) : null].filter(Boolean).join(" · ")}
      </p>
      {e.statusNote && e.status !== "active" && <Notice tone="warning">{e.statusNote}</Notice>}

      <section aria-labelledby="plans-heading" style={{ marginTop: "1rem" }}>
        <h2 id="plans-heading">{d.plansHeading}</h2>
        {plans.length === 0 ? (
          <p>{d.noPlans}</p>
        ) : (
          <ul className="tasks">
            {plans.map((p) => (
              <li key={p.id}>
                <PlanCard tenantId={tenantId} equipment={e} plan={p} onChanged={reload} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid-2" style={{ marginTop: "1.5rem" }}>
        {can("equipment:use") && <ServiceForm tenantId={tenantId} detail={q.data!} onSaved={reload} />}
        {e.tracksHours && (
          <section className="card" aria-labelledby="readings-heading">
            <h2 id="readings-heading" style={{ marginTop: 0 }}>
              {d.readingHeading}
            </h2>
            {can("equipment:use") && <ReadingForm tenantId={tenantId} equipmentId={e.id} current={e.currentHours} onSaved={reload} />}
            {readings.length === 0 ? (
              <p>{d.noReadings}</p>
            ) : (
              <ul className="season-batches">
                {readings.slice(0, 10).map((r) => (
                  <li key={r.id}>
                    {fmt.day(r.readOn)}: {h(r.hours)}
                    {r.recordedByName ? ` · ${r.recordedByName}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {can("equipment:manage") && <PlanForm tenantId={tenantId} equipment={e} today={q.data!.today} onSaved={reload} />}
        {can("equipment:manage") && <StatusForm tenantId={tenantId} equipment={e} onSaved={reload} />}
      </div>

      <section aria-labelledby="history-heading" style={{ marginTop: "1.5rem" }}>
        <h2 id="history-heading">{d.historyHeading}</h2>
        {services.length === 0 ? (
          <p>{d.noHistory}</p>
        ) : (
          <ul className="tasks">
            {services.map((s) => (
              <li key={s.id} className="task">
                <div className="task__head">
                  <strong>{s.description}</strong>
                  <span className="task__due">{fmt.day(s.doneOn)}</span>
                </div>
                <p className="task__meta">
                  {[s.planTitle, s.hours ? h(s.hours) : null, s.cost && s.currency ? fmt.currency(Number(s.cost), s.currency) : null, s.recordedByName]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function PlanCard({ tenantId, equipment, plan, onChanged }: { tenantId: string; equipment: Detail["equipment"]; plan: Detail["plans"][number]; onChanged: () => void }) {
  const { m, fmt } = useI18n();
  const t = m.equipment;
  const d = t.detail;
  const can = useCan();
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const path = { tenantId, equipmentId: equipment.id, planId: plan.id };

  async function makeTask() {
    setBusy(true);
    setError(undefined);
    try {
      const task = await unwrap(api.POST("/v1/tenants/{tenantId}/equipment/{equipmentId}/plans/{planId}/task", { params: { path }, body: {} }));
      announce(d.taskCreated(fmt.day(task.dueDate)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!window.confirm(d.stopConfirm(plan.title))) return;
    setBusy(true);
    try {
      await unwrap(api.POST("/v1/tenants/{tenantId}/equipment/{equipmentId}/plans/{planId}/archive", { params: { path } }));
      announce(d.planStopped);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="task" data-priority={plan.due.state === "overdue" ? "high" : undefined} aria-labelledby={`plan-${plan.id}`}>
      <div className="task__head">
        <h3 id={`plan-${plan.id}`} className="task__title">
          {plan.title}
        </h3>
        <StatusPill tone={dueTone(plan.due.state)}>{t.due[plan.due.state]}</StatusPill>
      </div>
      <p className="task__meta">
        {d.every(plan.everyHours ?? null, plan.everyDays ?? null)} · {d.lastDone(fmt.day(plan.lastDoneOn), plan.lastDoneHours ? fmt.number(Number(plan.lastDoneHours)) : null)}
      </p>
      <p className="task__notes">{d.dueAt(plan.due.dueOn ? fmt.day(plan.due.dueOn) : null, plan.due.dueHours)}</p>
      {plan.notes && <p className="task__notes">{plan.notes}</p>}
      {error && (
        <p className="mf-error" role="alert">
          {error}
        </p>
      )}
      <div className="task__actions">
        {can("task:manage") && equipment.farmId && (
          <Button busy={busy} onClick={makeTask}>
            {d.makeTask}
            <span className="mf-visually-hidden"> {plan.title}</span>
          </Button>
        )}
        {can("equipment:manage") && (
          <Button variant="danger" busy={busy} onClick={stop}>
            {d.stopPlan}
            <span className="mf-visually-hidden"> {plan.title}</span>
          </Button>
        )}
      </div>
    </article>
  );
}

function ReadingForm({ tenantId, equipmentId, current, onSaved }: { tenantId: string; equipmentId: string; current: string | null | undefined; onSaved: () => void }) {
  const { m } = useI18n();
  const d = m.equipment.detail;
  const announce = useAnnounce();
  const [hours, setHours] = useState("");
  const [date, setDate] = useState(localToday());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const v = hours.trim().replace(",", ".");
    if (!/^\d{1,7}(\.\d)?$/.test(v)) return setError(m.equipment.form.hoursInvalid);
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(api.POST("/v1/tenants/{tenantId}/equipment/{equipmentId}/readings", { params: { path: { tenantId, equipmentId } }, body: { hours: v, readOn: date } }));
      announce(d.readingAdded);
      setHours("");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-label={d.addReading}>
      <div className="grid-2">
        <TextField label={d.reading} inputMode="decimal" placeholder={current ?? undefined} value={hours} onChange={(e) => setHours(e.target.value)} error={error} />
        <TextField label={d.readOn} type="date" value={date} max={localToday()} onChange={(e) => setDate(e.target.value)} />
      </div>
      <Button type="submit" busy={busy}>
        {d.addReading}
      </Button>
    </form>
  );
}

function ServiceForm({ tenantId, detail, onSaved }: { tenantId: string; detail: Detail; onSaved: () => void }) {
  const { m } = useI18n();
  const d = m.equipment.detail;
  const announce = useAnnounce();
  const e = detail.equipment;
  const [planId, setPlanId] = useState("");
  const [date, setDate] = useState(localToday());
  const [hours, setHours] = useState("");
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState("");
  const [currency, setCurrency] = useState("IRR");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  function pick(id: string) {
    setPlanId(id);
    const p = detail.plans.find((x) => x.id === id);
    if (p && !description) setDescription(p.title);
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const h = hours.trim().replace(",", ".");
    const c = cost.trim().replace(",", ".");
    const p: { field?: string; message: string }[] = [];
    if (!description.trim()) p.push({ field: "svc-desc", message: d.descriptionRequired });
    if (h && !/^\d{1,7}(\.\d)?$/.test(h)) p.push({ field: "svc-hours", message: m.equipment.form.hoursInvalid });
    if (c && !/^\d{1,13}(\.\d{1,2})?$/.test(c)) p.push({ field: "svc-cost", message: m.inventory.numberInvalid });
    if (c && !/^[A-Z]{3}$/.test(currency)) p.push({ field: "svc-currency", message: m.inventory.move.costCurrency });
    setErrors(p);
    if (p.length) return;
    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/tenants/{tenantId}/equipment/{equipmentId}/services", {
          params: { path: { tenantId, equipmentId: e.id } },
          body: { planId: planId || null, doneOn: date, hours: h || null, description: description.trim(), cost: c || null, currency: c ? currency : null },
        }),
      );
      announce(d.serviceAdded);
      setPlanId("");
      setHours("");
      setDescription("");
      setCost("");
      onSaved();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  const err = (f: string) => errors.find((x) => x.field === f)?.message;
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="svc-heading">
      <h2 id="svc-heading" style={{ marginTop: 0 }}>
        {d.serviceHeading}
      </h2>
      <ErrorSummary errors={errors} />
      {detail.plans.length > 0 && (
        <SelectField label={d.servicePlan} value={planId} onChange={(ev) => pick(ev.target.value)}>
          <option value="">{d.noPlan}</option>
          {detail.plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </SelectField>
      )}
      <TextField id="svc-desc" label={d.description} value={description} maxLength={1000} onChange={(ev) => setDescription(ev.target.value)} error={err("svc-desc")} />
      <div className="grid-2">
        <TextField label={d.doneOn} type="date" value={date} max={localToday()} onChange={(ev) => setDate(ev.target.value)} />
        {e.tracksHours && <TextField id="svc-hours" label={d.serviceHours} inputMode="decimal" value={hours} onChange={(ev) => setHours(ev.target.value)} error={err("svc-hours")} />}
        <TextField id="svc-cost" label={d.cost} inputMode="decimal" value={cost} onChange={(ev) => setCost(ev.target.value)} error={err("svc-cost")} />
        <TextField id="svc-currency" label={d.currency} value={currency} maxLength={3} onChange={(ev) => setCurrency(ev.target.value.toUpperCase())} error={err("svc-currency")} />
      </div>
      <Button type="submit" variant="primary" busy={busy}>
        {d.addService}
      </Button>
    </form>
  );
}

function PlanForm({ tenantId, equipment, today, onSaved }: { tenantId: string; equipment: Detail["equipment"]; today: string; onSaved: () => void }) {
  const { m } = useI18n();
  const d = m.equipment.detail;
  const announce = useAnnounce();
  const [title, setTitle] = useState("");
  const [everyHours, setEveryHours] = useState("");
  const [everyDays, setEveryDays] = useState("");
  const [lastOn, setLastOn] = useState(today);
  const [lastHours, setLastHours] = useState(equipment.currentHours ?? "");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const whole = (v: string) => (v.trim() === "" ? null : /^\d{1,6}$/.test(v.trim()) ? Number(v) : NaN);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const eh = whole(everyHours);
    const ed = whole(everyDays);
    const lh = lastHours.trim().replace(",", ".");
    const p: { field?: string; message: string }[] = [];
    if (!title.trim()) p.push({ field: "plan-title", message: m.equipment.form.nameRequired });
    if (Number.isNaN(eh)) p.push({ field: "plan-hours", message: m.inventory.item.wholeNumber });
    if (Number.isNaN(ed)) p.push({ field: "plan-days", message: m.inventory.item.wholeNumber });
    if (!eh && !ed) p.push({ field: "plan-days", message: d.intervalRequired });
    if (eh && !/^\d{1,7}(\.\d)?$/.test(lh)) p.push({ field: "plan-last-hours", message: m.equipment.form.hoursInvalid });
    setErrors(p);
    if (p.length) return;
    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/tenants/{tenantId}/equipment/{equipmentId}/plans", {
          params: { path: { tenantId, equipmentId: equipment.id } },
          body: { title: title.trim(), everyHours: eh, everyDays: ed, lastDoneOn: lastOn, lastDoneHours: eh ? lh : null, notes: notes.trim() || null },
        }),
      );
      announce(d.planAdded);
      setTitle("");
      setEveryHours("");
      setEveryDays("");
      setNotes("");
      onSaved();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  const err = (f: string) => errors.find((x) => x.field === f)?.message;
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="plan-form-heading">
      <h2 id="plan-form-heading" style={{ marginTop: 0 }}>
        {d.planHeading}
      </h2>
      <ErrorSummary errors={errors} />
      <TextField id="plan-title" label={d.planTitle} hint={d.planTitleHint} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} error={err("plan-title")} />
      <div className="grid-2">
        {equipment.tracksHours && (
          <TextField id="plan-hours" label={d.everyHours} inputMode="numeric" value={everyHours} onChange={(e) => setEveryHours(e.target.value)} error={err("plan-hours")} />
        )}
        <TextField id="plan-days" label={d.everyDays} inputMode="numeric" value={everyDays} onChange={(e) => setEveryDays(e.target.value)} error={err("plan-days")} />
        <TextField label={d.lastDoneOn} type="date" value={lastOn} max={today} onChange={(e) => setLastOn(e.target.value)} />
        {equipment.tracksHours && everyHours.trim() && (
          <TextField id="plan-last-hours" label={d.lastDoneHours} inputMode="decimal" value={lastHours} onChange={(e) => setLastHours(e.target.value)} error={err("plan-last-hours")} />
        )}
      </div>
      <TextField label={d.planNotes} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
      <Button type="submit" variant="primary" busy={busy}>
        {d.addPlan}
      </Button>
    </form>
  );
}

function StatusForm({ tenantId, equipment, onSaved }: { tenantId: string; equipment: Detail["equipment"]; onSaved: () => void }) {
  const { m } = useI18n();
  const t = m.equipment;
  const d = t.detail;
  const announce = useAnnounce();
  const farms = useQuery(`farms:${tenantId}:equipment-form`, () => unwrap(api.GET("/v1/tenants/{tenantId}/farms", { params: { path: { tenantId }, query: { limit: 100 } } })));
  const [status, setStatus] = useState(equipment.status);
  const [note, setNote] = useState(equipment.statusNote ?? "");
  const [farmId, setFarmId] = useState(equipment.farmId ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(
        api.PATCH("/v1/tenants/{tenantId}/equipment/{equipmentId}", {
          params: { path: { tenantId, equipmentId: equipment.id } },
          body: { status, statusNote: status === "active" ? null : note.trim() || null, farmId: farmId || null },
        }),
      );
      announce(d.statusSaved);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="status-heading">
      <h2 id="status-heading" style={{ marginTop: 0 }}>
        {d.statusHeading}
      </h2>
      <SelectField label={d.status} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
        {EQUIPMENT_STATUSES.map((s) => (
          <option key={s} value={s}>
            {t.statuses[s]}
          </option>
        ))}
      </SelectField>
      {status !== "active" && <TextField label={d.statusNote} hint={d.statusNoteHint} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}
      <SelectField label={d.farm} value={farmId} onChange={(e) => setFarmId(e.target.value)}>
        <option value="">{t.form.noFarm}</option>
        {(farms.data?.items ?? []).map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </SelectField>
      {error && (
        <p className="mf-error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" busy={busy}>
        {d.saveStatus}
      </Button>
    </form>
  );
}
