"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { SEASON_STAGES, type SeasonStage } from "@metafarm/domain";
import { Button, Notice, SelectField, StatusPill, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";
import { localToday } from "@/lib/dates";
import { seasonTone } from "@/lib/seasons";

export default function SeasonPage() {
  const { farmId, seasonId } = useParams<{ farmId: string; seasonId: string }>();
  return <RequireTenant>{(tenantId) => <Season tenantId={tenantId} farmId={farmId} seasonId={seasonId} />}</RequireTenant>;
}

function Season({ tenantId, farmId, seasonId }: { tenantId: string; farmId: string; seasonId: string }) {
  const { m, fmt } = useI18n();
  const t = m.seasons;
  const d = t.detail;
  const can = useCan();
  const [version, setVersion] = useState(0);
  const q = useQuery(`season:${seasonId}:${version}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/seasons/{seasonId}", { params: { path: { tenantId, farmId, seasonId } } })),
  );
  const reload = () => setVersion((v) => v + 1);
  if (q.loading && !q.data) return <p role="status">{t.loading}</p>;
  if (q.error) return <Notice tone="error" title={t.couldNotLoad}>{q.error.message}</Notice>;
  const { season: s, stages, harvest, inputs, tasks } = q.data!;
  const n = (v: string) => fmt.number(Number(v), { maximumFractionDigits: 3 });

  return (
    <>
      <p>
        <Link href={`/farms/${farmId}/seasons`}>{d.back}</Link>
      </p>
      <div className="task__head">
        <h1 style={{ margin: 0 }}>
          {s.cropName}
          {s.variety ? ` · ${s.variety}` : ""}
        </h1>
        <StatusPill tone={seasonTone(s.status)}>{t.statuses[s.status]}</StatusPill>
      </div>
      <p className="mf-hint">
        {[
          s.parcelLabel ?? t.wholeFarm,
          s.areaHa ? `${fmt.number(Number(s.areaHa), { maximumFractionDigits: 4 })} ${fmt.unitHa}` : null,
          t.started(fmt.day(s.plannedStart)),
          s.endedOn ? t.ended(fmt.day(s.endedOn)) : s.expectedHarvestFrom ? t.expected(fmt.day(s.expectedHarvestFrom)) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {s.notes && <p className="task__notes">{s.notes}</p>}

      <div className="grid-2" style={{ marginTop: "1rem" }}>
        <section className="card" aria-labelledby="stages-heading">
          <h2 id="stages-heading" style={{ marginTop: 0 }}>
            {d.stagesHeading}
          </h2>
          {stages.length === 0 ? (
            <p>{t.noStage}</p>
          ) : (
            <ol className="stage-line">
              {stages.map((x) => (
                <li key={x.id}>
                  <strong>{t.stages[x.stage]}</strong> <span className="mf-hint">{fmt.day(x.observedOn)}</span>
                  {x.note && <p className="task__notes">{x.note}</p>}
                </li>
              ))}
            </ol>
          )}
          {s.status !== "closed" && can("observation:write") && <StageForm tenantId={tenantId} farmId={farmId} season={s} onSaved={reload} />}
        </section>

        <section className="card" aria-labelledby="harvest-heading">
          <h2 id="harvest-heading" style={{ marginTop: 0 }}>
            {d.harvestHeading}
          </h2>
          {harvest.batches.length === 0 ? (
            <p>{d.noHarvest}</p>
          ) : (
            <>
              <dl className="facts">
                {harvest.totals.map((tot) => (
                  <div key={tot.unit}>
                    <dt>
                      {d.total} ({tot.unit})
                    </dt>
                    <dd>
                      {n(tot.quantity)} {tot.unit}
                      {tot.perHa ? ` · ${d.perHa}: ${n(tot.perHa)} ${tot.unit}` : ""}
                    </dd>
                  </div>
                ))}
              </dl>
              <ul className="season-batches">
                {harvest.batches.map((b) => (
                  <li key={b.id} data-voided={b.voided || undefined}>
                    <Link href={`/verify/${b.code}`} target="_blank" rel="noopener" className="harvest__code ltr">
                      {b.code}
                    </Link>{" "}
                    {fmt.day(b.harvestedOn)} · {n(b.quantity)} {b.unit}
                    {b.voided ? ` · ${d.voided}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="card" aria-labelledby="inputs-heading">
          <h2 id="inputs-heading" style={{ marginTop: 0 }}>
            {d.inputsHeading}
          </h2>
          {inputs.length === 0 ? (
            <p>{d.noInputs}</p>
          ) : (
            <ul className="season-batches">
              {inputs.map((i) => (
                <li key={i.itemId}>
                  <strong>{i.itemName}</strong>: {n(i.quantity)} {i.unit} · {d.applications(i.applications)}
                </li>
              ))}
            </ul>
          )}
          <h2 style={{ fontSize: "1.1rem" }}>{d.tasksHeading}</h2>
          <p>{d.tasks(tasks.done, tasks.open)}</p>
        </section>

        {can("plan:write") && <StatusPanel tenantId={tenantId} farmId={farmId} season={s} today={q.data!.today} onChanged={reload} />}
      </div>
    </>
  );
}

function StageForm({ tenantId, farmId, season, onSaved }: { tenantId: string; farmId: string; season: Schemas["Season"]; onSaved: () => void }) {
  const { m } = useI18n();
  const d = m.seasons.detail;
  const announce = useAnnounce();
  const next = SEASON_STAGES[Math.min(SEASON_STAGES.length - 1, season.currentStage ? SEASON_STAGES.indexOf(season.currentStage) + 1 : 0)]!;
  const [stage, setStage] = useState<SeasonStage>(next);
  const [date, setDate] = useState(localToday());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(
        api.POST("/v1/tenants/{tenantId}/farms/{farmId}/seasons/{seasonId}/stages", {
          params: { path: { tenantId, farmId, seasonId: season.id } },
          body: { stage, observedOn: date, note: note.trim() || null },
        }),
      );
      announce(d.saved);
      setNote("");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="task__complete" aria-label={d.addStage}>
      <SelectField label={d.stage} value={stage} onChange={(e) => setStage(e.target.value as SeasonStage)}>
        {SEASON_STAGES.map((x) => (
          <option key={x} value={x}>
            {m.seasons.stages[x]}
          </option>
        ))}
      </SelectField>
      <TextField label={d.observedOn} type="date" value={date} min={season.plannedStart} max={localToday()} onChange={(e) => setDate(e.target.value)} />
      <TextField label={d.note} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      {error && (
        <p className="mf-error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" busy={busy}>
        {d.save}
      </Button>
    </form>
  );
}

function StatusPanel({ tenantId, farmId, season, today, onChanged }: { tenantId: string; farmId: string; season: Schemas["Season"]; today: string; onChanged: () => void }) {
  const d = useI18n().m.seasons.detail;
  const announce = useAnnounce();
  const [endedOn, setEndedOn] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function change(body: Schemas["SeasonUpdate"], message: string) {
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(api.PATCH("/v1/tenants/{tenantId}/farms/{farmId}/seasons/{seasonId}", { params: { path: { tenantId, farmId, seasonId: season.id } }, body }));
      announce(message);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="season-status-heading">
      <h2 id="season-status-heading" style={{ marginTop: 0 }}>
        {d.manage}
      </h2>
      {error && (
        <p className="mf-error" role="alert">
          {error}
        </p>
      )}
      {season.status === "closed" ? (
        <Button busy={busy} onClick={() => change({ status: "active" }, d.reopened)}>
          {d.reopen}
        </Button>
      ) : (
        <>
          {season.status === "planned" && (
            <p>
              <Button busy={busy} onClick={() => change({ status: "active" }, d.reopened)}>
                {d.activate}
              </Button>
            </p>
          )}
          <TextField label={d.closeOn} type="date" value={endedOn} min={season.plannedStart} onChange={(e) => setEndedOn(e.target.value)} />
          <Button variant="danger" busy={busy} onClick={() => change({ status: "closed", endedOn }, d.closed)}>
            {d.close}
          </Button>
        </>
      )}
    </section>
  );
}
