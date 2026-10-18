"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Button, Notice, SelectField, TextField } from "@metafarm/ui";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { localToday } from "@/lib/dates";
import { PERIODS, periodRange, type Period } from "@/lib/periods";

type Report = Schemas["PeriodReport"];

/**
 * What the team recorded in a period: work done, inputs applied, harvests, spending and alerts.
 * With `farmId` it covers that farm; otherwise the reader can pick a farm or the whole workspace.
 */
export function PeriodReport({ tenantId, farmId: fixedFarm }: { tenantId: string; farmId?: string }) {
  const { m, fmt, locale } = useI18n();
  const t = m.reports;
  const today = localToday();
  const calendar = locale === "fa" ? "persian" : "gregory";
  const [period, setPeriod] = useState<Period | "custom">("lastWeek");
  const [custom, setCustom] = useState(() => periodRange("lastWeek", today, { weekStartsOn: fmt.weekStartsOn, calendar }));
  const [farm, setFarm] = useState(fixedFarm ?? "");
  const range = period === "custom" ? custom : periodRange(period, today, { weekStartsOn: fmt.weekStartsOn, calendar });
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(range.from) && /^\d{4}-\d{2}-\d{2}$/.test(range.to) && range.from <= range.to;

  const farms = useQuery(fixedFarm ? null : `farms:${tenantId}:report`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms", { params: { path: { tenantId }, query: { limit: 100 } } })),
  );
  const report = useQuery(valid ? `report:${tenantId}:${farm}:${range.from}:${range.to}` : null, () =>
    unwrap(
      api.GET("/v1/tenants/{tenantId}/reports/summary", {
        params: { path: { tenantId }, query: { from: range.from, to: range.to, ...(farm ? { farmId: farm } : {}) } },
      }),
    ),
  );
  const r = report.data;

  return (
    <>
      <form className="report-controls card" aria-label={t.controls} onSubmit={(e) => e.preventDefault()}>
        {!fixedFarm && (
          <SelectField label={t.farm} value={farm} onChange={(e) => setFarm(e.target.value)}>
            <option value="">{t.allFarms}</option>
            {(farms.data?.items ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </SelectField>
        )}
        <SelectField label={t.period} value={period} onChange={(e) => setPeriod(e.target.value as Period | "custom")}>
          {PERIODS.map((p) => (
            <option key={p} value={p}>
              {t.periods[p]}
            </option>
          ))}
          <option value="custom">{t.periods.custom}</option>
        </SelectField>
        {period === "custom" && (
          <>
            <TextField label={t.from} type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            <TextField
              label={t.to}
              type="date"
              value={custom.to}
              min={custom.from}
              onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
              error={!valid ? t.badRange : undefined}
            />
          </>
        )}
        <div className="report-controls__print">
          <Button onClick={() => window.print()}>{t.print}</Button>
        </div>
      </form>

      {report.loading && !r && <p role="status">{t.loading}</p>}
      {report.error && (
        <Notice tone="error" title={t.couldNotLoad}>
          {report.error.message}
        </Notice>
      )}
      {r && <ReportBody r={r} showFarms={!fixedFarm && !farm} />}
    </>
  );
}

function ReportBody({ r, showFarms }: { r: Report; showFarms: boolean }) {
  const { m, fmt } = useI18n();
  const t = m.reports;
  const n = (x: number) => fmt.number(x);
  const qty = (q: string, unit: string) => `${fmt.number(Number(q), { maximumFractionDigits: 3 })} ${unit}`;
  const money = (x: Schemas["Money"]) => {
    try {
      return fmt.currency(Number(x.amount), x.currency);
    } catch {
      return `${fmt.number(Number(x.amount))} ${x.currency}`;
    }
  };
  const batches = r.harvests.reduce((s, h) => s + h.batches, 0);
  const alerts = r.alerts.info + r.alerts.warning + r.alerts.critical;
  const readings = r.observations.userEntered + r.observations.sensorReported + r.observations.providerObservation;
  const spent = r.spending.deliveries.length + r.spending.servicing.length > 0;

  return (
    <article className="report" aria-labelledby="report-heading">
      <h2 id="report-heading">{t.heading(r.farm?.name ?? null, fmt.day(r.from), fmt.day(r.to))}</h2>

      <dl className="stats">
        <div>
          <dt>{t.tasksDone}</dt>
          <dd>{n(r.tasks.completed)}</dd>
        </div>
        <div>
          <dt>{t.dueOpen}</dt>
          <dd>{n(r.tasks.dueStillOpen)}</dd>
        </div>
        <div>
          <dt>{t.harvestBatches}</dt>
          <dd>{n(batches)}</dd>
        </div>
        <div>
          <dt>{t.alerts}</dt>
          <dd>{n(alerts)}</dd>
        </div>
      </dl>

      <section aria-labelledby="report-work" className="report__section">
        <h3 id="report-work">{t.work}</h3>
        <p className="mf-hint">{t.workSummary(r.tasks.completed, r.tasks.due, r.tasks.dueStillOpen)}</p>
        {r.tasks.completed === 0 ? (
          <p>{t.nothing}</p>
        ) : (
          <div className="report__pair">
            <Table caption={t.byKind} head={[t.colKind, t.colDone]} rows={r.tasks.byKind.map((k) => [m.tasks.kinds[k.kind as keyof typeof m.tasks.kinds] ?? k.kind, n(k.count)])} />
            <Table caption={t.byPerson} head={[t.colPerson, t.colDone]} rows={r.tasks.byPerson.map((p) => [p.name ?? t.someone, n(p.count)])} />
          </div>
        )}
      </section>

      <section aria-labelledby="report-inputs" className="report__section">
        <h3 id="report-inputs">{t.inputs}</h3>
        {r.inputs.length === 0 ? (
          <p>{t.nothing}</p>
        ) : (
          <Table
            caption={t.inputs}
            hideCaption
            head={[t.colInput, t.colCategory, t.colUsed, t.colApplications]}
            rows={r.inputs.map((i) => [i.name, m.inventory.categories[i.category as keyof typeof m.inventory.categories] ?? i.category, qty(i.used, i.unit), n(i.applications)])}
          />
        )}
      </section>

      <section aria-labelledby="report-harvests" className="report__section">
        <h3 id="report-harvests">{t.harvests}</h3>
        {r.harvests.length === 0 ? (
          <p>{t.nothing}</p>
        ) : (
          <Table caption={t.harvests} hideCaption head={[t.colCrop, t.colQuantity, t.colBatches]} rows={r.harvests.map((h) => [h.crop, qty(h.quantity, h.unit), n(h.batches)])} />
        )}
      </section>

      <section aria-labelledby="report-spending" className="report__section">
        <h3 id="report-spending">{t.spending}</h3>
        <p className="mf-hint">{r.farm ? t.spendingFarmHint : t.spendingHint}</p>
        {!spent ? (
          <p>{t.nothing}</p>
        ) : (
          <Table
            caption={t.spending}
            hideCaption
            head={[t.colWhat, t.colAmount, t.colEntries]}
            rows={[
              ...r.spending.deliveries.map((x) => [t.deliveries, money(x), n(x.entries)]),
              ...r.spending.servicing.map((x) => [t.servicing, money(x), n(x.entries)]),
            ]}
          />
        )}
      </section>

      <section aria-labelledby="report-watch" className="report__section">
        <h3 id="report-watch">{t.watch}</h3>
        <ul>
          <li>{t.alertsLine(r.alerts.critical, r.alerts.warning, r.alerts.info)}</li>
          <li>{t.readingsLine(readings, r.observations.userEntered, r.observations.sensorReported)}</li>
        </ul>
      </section>

      {showFarms && r.farms.length > 1 && (
        <section aria-labelledby="report-farms" className="report__section">
          <h3 id="report-farms">{t.byFarm}</h3>
          <Table
            caption={t.byFarm}
            hideCaption
            head={[t.colFarm, t.colDone, t.colApplications, t.colBatches, t.alerts]}
            rows={r.farms.map((f) => [
              <Link key="f" href={`/farms/${f.farmId}/report`}>
                {f.name}
              </Link>,
              n(f.tasksCompleted),
              n(f.applications),
              n(f.harvestBatches),
              n(f.alerts),
            ])}
          />
        </section>
      )}
      <p className="mf-hint">{t.source}</p>
    </article>
  );
}

function Table({ caption, hideCaption, head, rows }: { caption: string; hideCaption?: boolean; head: string[]; rows: ReactNode[][] }) {
  return (
    // Narrow screens scroll wide tables sideways; the region takes focus so keyboard users can scroll it too.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table>
        <caption className={hideCaption ? "mf-visually-hidden" : undefined}>{caption}</caption>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((c, j) =>
                j === 0 ? (
                  <th key={j} scope="row">
                    {c}
                  </th>
                ) : (
                  <td key={j}>{c}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
