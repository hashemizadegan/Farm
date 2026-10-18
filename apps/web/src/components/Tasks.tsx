"use client";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { TASK_KINDS, TASK_PRIORITIES, type TaskKind, type TaskPriority } from "@metafarm/domain";
import { Button, ErrorSummary, SelectField, StatusPill, TextField, useAnnounce } from "@metafarm/ui";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";
import { localToday } from "@/lib/dates";
import { sendOrQueue, useOutbox } from "@/lib/outbox";
import { useTenant } from "@/lib/tenant";
import { FileUploader } from "./FileUploader";

export type Task = Schemas["Task"];

export interface TaskGroups {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  done: Task[];
  cancelled: Task[];
}

/** Sorts tasks into the groups a team works through: overdue first, then today, then later. */
export function groupTasks(items: Task[], today = localToday()): TaskGroups {
  const g: TaskGroups = { overdue: [], today: [], upcoming: [], done: [], cancelled: [] };
  for (const t of items) {
    if (t.status === "done") g.done.push(t);
    else if (t.status === "cancelled") g.cancelled.push(t);
    else if (t.dueDate < today) g.overdue.push(t);
    else if (t.dueDate === today) g.today.push(t);
    else g.upcoming.push(t);
  }
  return g;
}

/** Grouped task list with a heading per non-empty group. */
export function TaskGroupsView({
  items,
  tenantId,
  showFarm,
  headingLevel = 2,
  onChanged,
}: {
  items: Task[];
  tenantId: string;
  showFarm?: boolean;
  headingLevel?: 2 | 3;
  onChanged: () => void;
}) {
  const { m } = useI18n();
  const groups = groupTasks(items);
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <>
      {(Object.keys(groups) as (keyof TaskGroups)[]).map((k) =>
        groups[k].length === 0 ? null : (
          <section key={k} className="task-group" data-group={k} aria-labelledby={`tasks-${k}`}>
            <H id={`tasks-${k}`} className="task-group__heading">
              {m.tasks.groups[k]} <span className="task-group__count">({groups[k].length})</span>
            </H>
            <ul className="tasks">
              {groups[k].map((t) => (
                <li key={t.id}>
                  <TaskCard task={t} tenantId={tenantId} showFarm={showFarm} overdue={k === "overdue"} titleLevel={headingLevel === 2 ? 3 : 4} onChanged={onChanged} />
                </li>
              ))}
            </ul>
          </section>
        ),
      )}
    </>
  );
}

export function TaskCard({
  task,
  tenantId,
  showFarm,
  overdue,
  titleLevel = 3,
  onChanged,
}: {
  task: Task;
  tenantId: string;
  showFarm?: boolean;
  overdue?: boolean;
  titleLevel?: 3 | 4;
  onChanged: () => void;
}) {
  const Title = titleLevel === 3 ? "h3" : "h4";
  const { m, fmt } = useI18n();
  const t = m.tasks;
  const can = useCan();
  const { me } = useTenant();
  const announce = useAnnounce();
  const [completing, setCompleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const manage = can("task:manage");
  const mine = !task.assigneeUserId || task.assigneeUserId === me?.userId;
  const mayWork = manage || (can("task:work") && mine);
  // Completed on this phone without signal and not sent yet: treat as done here.
  const queued = useOutbox(me?.userId).find((e) => e.kind === "task" && e.path.endsWith(`/tasks/${task.id}/complete`));
  const open = (task.status === "todo" || task.status === "in_progress") && !queued;
  const path = { tenantId, farmId: task.farmId, taskId: task.id };

  async function patch(body: Schemas["TaskUpdate"], message: string) {
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(api.PATCH("/v1/tenants/{tenantId}/farms/{farmId}/tasks/{taskId}", { params: { path }, body }));
      announce(message);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const meta = [
    t.kinds[task.kind],
    task.parcelLabel,
    task.assigneeUserId ? t.card.assigned(task.assigneeName ?? t.card.someone) : t.card.unassigned,
    task.repeatEveryDays ? t.card.repeats(task.repeatEveryDays) : null,
  ].filter(Boolean);

  return (
    <article className="task" data-status={task.status} data-priority={task.priority} aria-labelledby={`task-${task.id}`}>
      <div className="task__head">
        <Title id={`task-${task.id}`} className="task__title">
          {task.title}
        </Title>
        <span className="task__due" data-overdue={overdue || undefined}>
          {t.card.due(fmt.day(task.dueDate))}
        </span>
      </div>
      <p className="task__meta">
        {showFarm && (
          <>
            <Link href={`/farms/${task.farmId}/tasks`}>{task.farmName}</Link>
            {" · "}
          </>
        )}
        {meta.join(" · ")}
      </p>
      <div className="task__status">
        {task.status === "in_progress" && <StatusPill tone="pending">{t.statuses.in_progress}</StatusPill>}
        {task.status === "done" && <StatusPill tone="ok">{t.statuses.done}</StatusPill>}
        {task.status === "cancelled" && <StatusPill tone="neutral">{t.statuses.cancelled}</StatusPill>}
        {queued && <StatusPill tone={queued.status === "failed" ? "problem" : "pending"}>{queued.status === "failed" ? m.offline.notSent : m.offline.waiting}</StatusPill>}
        {open && task.priority === "high" && <StatusPill tone="problem">{t.priorities.high}</StatusPill>}
      </div>
      {task.notes && <p className="task__notes">{task.notes}</p>}
      {task.status === "done" && (
        <p className="mf-hint">
          {task.completedAt && (task.completedByName ? t.card.completedBy(task.completedByName, fmt.dateTime(task.completedAt)) : t.card.completedAt(fmt.dateTime(task.completedAt)))}
          {task.completionNote ? ` — ${task.completionNote}` : ""}
        </p>
      )}
      {error && (
        <p className="mf-error" role="alert">
          {error}
        </p>
      )}
      {completing ? (
        <CompletePanel
          task={task}
          tenantId={tenantId}
          onDone={() => {
            setCompleting(false);
            onChanged();
          }}
          onBack={() => setCompleting(false)}
        />
      ) : (
        <div className="task__actions">
          {open && mayWork && task.status === "todo" && (
            <Button busy={busy} onClick={() => patch({ status: "in_progress" }, t.card.started(task.title))}>
              {t.card.start}
              <span className="mf-visually-hidden">{t.card.actionsFor(task.title)}</span>
            </Button>
          )}
          {open && mayWork && (
            <Button variant="primary" onClick={() => setCompleting(true)}>
              {t.card.complete}
              <span className="mf-visually-hidden">{t.card.actionsFor(task.title)}</span>
            </Button>
          )}
          {open && manage && (
            <Button
              variant="danger"
              busy={busy}
              onClick={() => window.confirm(t.card.cancelConfirm(task.title)) && patch({ status: "cancelled" }, t.card.cancelled)}
            >
              {t.card.cancel}
              <span className="mf-visually-hidden">{t.card.actionsFor(task.title)}</span>
            </Button>
          )}
          {task.status === "cancelled" && manage && (
            <Button busy={busy} onClick={() => patch({ status: "todo" }, t.card.reopened)}>
              {t.card.reopen}
              <span className="mf-visually-hidden">{t.card.actionsFor(task.title)}</span>
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

function CompletePanel({ task, tenantId, onDone, onBack }: { task: Task; tenantId: string; onDone: () => void; onBack: () => void }) {
  const { m, fmt } = useI18n();
  const t = m.tasks.card;
  const announce = useAnnounce();
  const can = useCan();
  const { me } = useTenant();
  const noteId = useId();
  const [note, setNote] = useState("");
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [inputs, setInputs] = useState<{ itemId: string; quantity: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const stock = useQuery(can("inventory:use") ? `inventory:${tenantId}:for-task` : null, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/inventory/items", { params: { path: { tenantId } } })),
  );
  const items = stock.data?.items ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const used = inputs.filter((i) => i.itemId || i.quantity.trim()).map((i) => ({ itemId: i.itemId, quantity: i.quantity.trim().replace(",", ".") }));
    if (used.some((i) => !i.itemId || !/^\d{1,11}(\.\d{1,3})?$/.test(i.quantity) || !(Number(i.quantity) > 0))) {
      setError(m.inventory.numberInvalid);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const body: Schemas["TaskCompletion"] = { ...(note.trim() ? { note: note.trim() } : {}), mediaIds, inputs: used };
      const r = await sendOrQueue<{ task: Task; next: Task | null }>({
        userId: me!.userId,
        tenantId,
        kind: "task",
        label: task.title,
        path: `/v1/tenants/${tenantId}/farms/${task.farmId}/tasks/${task.id}/complete`,
        body,
      });
      if (r.queued) announce(m.offline.savedTask(task.title));
      else announce(r.data.next ? t.doneNext(fmt.day(r.data.next.dueDate)) : t.done);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="task__complete" onSubmit={submit} noValidate aria-label={t.completeHeading(task.title)}>
      <div className="mf-field">
        <label htmlFor={noteId}>{t.note}</label>
        <p id={`${noteId}-hint`} className="mf-hint">
          {t.noteHint}
        </p>
        <textarea id={noteId} aria-describedby={`${noteId}-hint`} rows={3} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {items.length > 0 && (
        <fieldset className="task__inputs">
          <legend>{t.inputs}</legend>
          <p className="mf-hint">{t.inputsHint}</p>
          {inputs.map((row, n) => {
            const unit = items.find((i) => i.id === row.itemId)?.unit;
            const set = (patch: Partial<typeof row>) => setInputs((rows) => rows.map((r, k) => (k === n ? { ...r, ...patch } : r)));
            return (
              <div key={n} className="task__input-row">
                <SelectField label={t.inputItem(n + 1)} value={row.itemId} onChange={(e) => set({ itemId: e.target.value })}>
                  <option value="">{m.farmInputs.choose}</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.unit})
                    </option>
                  ))}
                </SelectField>
                <TextField label={unit ? `${t.inputQty(n + 1)} (${unit})` : t.inputQty(n + 1)} inputMode="decimal" value={row.quantity} onChange={(e) => set({ quantity: e.target.value })} />
                <Button variant="danger" onClick={() => setInputs((rows) => rows.filter((_, k) => k !== n))}>
                  {t.removeInput(n + 1)}
                </Button>
              </div>
            );
          })}
          {inputs.length < 10 && <Button onClick={() => setInputs((rows) => [...rows, { itemId: "", quantity: "" }])}>{t.addInput}</Button>}
        </fieldset>
      )}
      {can("media:upload") && (
        <FileUploader
          tenantId={tenantId}
          farmId={task.farmId}
          purpose="observation-photo"
          label={t.photo}
          onUploaded={(list) => setMediaIds((ids) => [...ids, ...list.map((x) => x.id)].slice(0, 10))}
        />
      )}
      {mediaIds.length > 0 && <p className="mf-hint">{t.photosAttached(mediaIds.length)}</p>}
      {error && (
        <p className="mf-error" role="alert">
          {error}
        </p>
      )}
      <div className="task__actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.save}
        </Button>
        <Button onClick={onBack}>{t.back}</Button>
      </div>
    </form>
  );
}

/** Managers' form for a new task on one farm. */
export function NewTaskForm({ tenantId, farmId, onCreated }: { tenantId: string; farmId: string; onCreated: () => void }) {
  const { m } = useI18n();
  const t = m.tasks.form;
  const announce = useAnnounce();
  const members = useQuery(`members:${tenantId}`, () => unwrap(api.GET("/v1/tenants/{tenantId}/members", { params: { path: { tenantId } } })));
  const plan = useQuery(`plan:${farmId}:labels`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/plan", { params: { path: { tenantId, farmId } } })).catch(() => null),
  );
  const parcelsId = useId();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<TaskKind>("irrigation");
  const [parcel, setParcel] = useState("");
  const [assignee, setAssignee] = useState("");
  const [dueDate, setDueDate] = useState(localToday());
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [repeat, setRepeat] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problems: { field?: string; message: string }[] = [];
    if (!title.trim()) problems.push({ field: "task-title", message: t.titleRequired });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) problems.push({ field: "task-due", message: t.dueRequired });
    const every = repeat.trim() === "" ? null : Number(repeat);
    if (every !== null && !(Number.isInteger(every) && every >= 1 && every <= 365)) problems.push({ field: "task-repeat", message: t.repeatInvalid });
    setErrors(problems);
    if (problems.length) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-error-summary]")?.focus());
      return;
    }
    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/tenants/{tenantId}/farms/{farmId}/tasks", {
          params: { path: { tenantId, farmId } },
          body: {
            title: title.trim(),
            kind,
            parcelLabel: parcel.trim() || null,
            assigneeUserId: assignee || null,
            dueDate,
            priority,
            notes: notes.trim() || null,
            repeatEveryDays: every,
          },
        }),
      );
      announce(t.created);
      setTitle("");
      setNotes("");
      setRepeat("");
      onCreated();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  const err = (f: string) => errors.find((x) => x.field === f)?.message;
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="new-task-heading">
      <h2 id="new-task-heading" style={{ marginTop: 0 }}>
        {t.heading}
      </h2>
      <ErrorSummary errors={errors} />
      <TextField id="task-title" label={t.title} hint={t.titleHint} value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} error={err("task-title")} />
      <div className="grid-2">
        <SelectField label={t.kind} value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
          {TASK_KINDS.map((k) => (
            <option key={k} value={k}>
              {m.tasks.kinds[k]}
            </option>
          ))}
        </SelectField>
        <TextField label={t.parcel} hint={t.parcelHint} list={parcelsId} value={parcel} maxLength={80} onChange={(e) => setParcel(e.target.value)} />
        <datalist id={parcelsId}>
          {(plan.data?.parcels ?? []).map((p) => (
            <option key={p.label} value={p.label} />
          ))}
        </datalist>
        <SelectField label={t.assignee} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">{t.unassigned}</option>
          {(members.data?.items ?? []).map((mb) => (
            <option key={mb.userId} value={mb.userId}>
              {mb.displayName || mb.email || mb.userId.slice(0, 8)} — {m.roles[mb.role].label}
            </option>
          ))}
        </SelectField>
        <TextField id="task-due" label={t.due} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} error={err("task-due")} />
        <SelectField label={t.priority} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {m.tasks.priorities[p]}
            </option>
          ))}
        </SelectField>
        <TextField
          id="task-repeat"
          label={t.repeat}
          hint={t.repeatHint}
          type="number"
          inputMode="numeric"
          min={1}
          max={365}
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          error={err("task-repeat")}
        />
      </div>
      <div className="mf-field">
        <label htmlFor="task-notes">{t.notes}</label>
        <textarea id="task-notes" rows={3} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <Button type="submit" variant="primary" busy={busy}>
        {t.create}
      </Button>
    </form>
  );
}
