"use client";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { METRICS } from "@metafarm/domain";
import { Button, Notice, SelectField, StatusPill, TextField, useAnnounce } from "@metafarm/ui";
import { useCan } from "@/lib/can";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";
import { useI18n } from "@/i18n/provider";

type Status = "open" | "acknowledged" | "resolved" | "";

export default function AlertsPage() {
  const { farmId } = useParams<{ farmId: string }>();
  const t = useI18n().m.alerts;
  return (
    <>
      <h1>{t.title}</h1>
      <p className="mf-muted">{t.intro}</p>
      <RequireTenant>
        {(tenantId) => (
          <>
            <Alerts tenantId={tenantId} farmId={farmId} />
            <AlertRules tenantId={tenantId} farmId={farmId} />
          </>
        )}
      </RequireTenant>
    </>
  );
}

function Alerts({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const announce = useAnnounce();
  const { m, fmt } = useI18n();
  const t = m.alerts;
  const [status, setStatus] = useState<Status>("open");
  const alerts = useQuery(
    `alerts:${farmId}:${status}`,
    () => unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/alerts", { params: { path: { tenantId, farmId }, query: status ? { status } : {} } })),
    { pollMs: 15_000 },
  );

  const ack = async (alertId: string) => {
    try {
      await unwrap(api.POST("/v1/tenants/{tenantId}/farms/{farmId}/alerts/{alertId}/ack", { params: { path: { tenantId, farmId, alertId } }, body: {} }));
      announce(t.acknowledged);
      alerts.reload();
    } catch (err) {
      announce(t.couldNotAck((err as Error).message), "assertive");
    }
  };

  return (
    <>
      <SelectField label={t.show} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
        <option value="open">{t.filter.open}</option>
        <option value="acknowledged">{t.filter.acknowledged}</option>
        <option value="resolved">{t.filter.resolved}</option>
        <option value="">{t.filter.all}</option>
      </SelectField>
      {alerts.error && <Notice tone="error">{alerts.error.message}</Notice>}
      {alerts.data?.items.length === 0 && <p>{t.none}</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {alerts.data?.items.map((a) => (
          <li key={a.id} className="card" style={{ marginBottom: "0.75rem" }}>
            <p>
              <strong>{t.severity[a.severity] ?? a.severity}</strong> — {a.message}
            </p>
            <p className="mf-muted">
              {t.raised(() => <time dateTime={a.createdAt}>{fmt.dateTime(a.createdAt)}</time>, a.evidenceObservationIds.length, t.status[a.status] ?? a.status)}
            </p>
            {a.status === "open" && <Button onClick={() => ack(a.id)}>{t.ack}<span className="mf-visually-hidden">{t.ackHidden(a.message)}</span></Button>}
          </li>
        ))}
      </ul>
    </>
  );
}

const RULE_METRICS = (Object.keys(METRICS) as (keyof typeof METRICS)[]).filter((k) => k !== "note");
const COMPARATORS = ["lt", "lte", "gt", "gte"] as const;
const SEVERITIES = ["info", "warning", "critical"] as const;

function AlertRules({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const { m, fmt } = useI18n();
  const t = m.alertRules;
  const can = useCan();
  const announce = useAnnounce();
  const [version, setVersion] = useState(0);
  const rules = useQuery(`alert-rules:${farmId}:${version}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/alert-rules", { params: { path: { tenantId, farmId } } })),
  );
  const [metric, setMetric] = useState<(typeof RULE_METRICS)[number]>("soil_moisture");
  const [comparator, setComparator] = useState<(typeof COMPARATORS)[number]>("lt");
  const [threshold, setThreshold] = useState("");
  const [consecutive, setConsecutive] = useState("1");
  const [windowMinutes, setWindowMinutes] = useState("60");
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>("warning");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const unitOf = (metricName: string) => {
    const u = METRICS[metricName as keyof typeof METRICS]?.unit ?? "";
    return m.observations.units[u] ?? u;
  };

  async function toggle(id: string, enabled: boolean) {
    await unwrap(api.PATCH("/v1/tenants/{tenantId}/farms/{farmId}/alert-rules/{ruleId}", { params: { path: { tenantId, farmId, ruleId: id } }, body: { enabled } })).catch(
      (err: Error) => setError(err.message),
    );
    setVersion((v) => v + 1);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const th = Number(threshold.replace(",", "."));
    const n = Number(consecutive);
    const w = Number(windowMinutes);
    if (threshold.trim() === "" || !Number.isFinite(th) || !Number.isInteger(n) || n < 1 || !Number.isInteger(w) || w < 1) return setError(t.form.thresholdInvalid);
    setBusy(true);
    setError(undefined);
    try {
      await unwrap(
        api.POST("/v1/tenants/{tenantId}/farms/{farmId}/alert-rules", {
          params: { path: { tenantId, farmId } },
          body: { metric, comparator, threshold: th, consecutive: n, windowMinutes: w, severity },
        }),
      );
      announce(t.form.added);
      setThreshold("");
      setVersion((v) => v + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const items = rules.data?.items ?? [];
  return (
    <section aria-labelledby="rules-heading" style={{ marginTop: "2rem" }}>
      <h2 id="rules-heading">{t.heading}</h2>
      <p className="mf-hint">{t.intro}</p>
      {rules.data && items.length === 0 && <p>{t.none}</p>}
      {items.length > 0 && (
        <ul className="files">
          {items.map((r) => (
            <li key={r.id}>
              <span>
                <StatusPill tone={r.enabled ? (r.severity === "critical" ? "problem" : "pending") : "neutral"}>{r.enabled ? t.severities[r.severity] : t.off}</StatusPill>{" "}
                {t.describe(m.observations.metrics[r.metric] ?? r.metric, t.comparators[r.comparator], fmt.number(r.threshold), unitOf(r.metric), r.consecutive, r.windowMinutes)}
              </span>
              {can("sensor:manage") && <Button onClick={() => toggle(r.id, !r.enabled)}>{r.enabled ? t.turnOff : t.turnOn}</Button>}
            </li>
          ))}
        </ul>
      )}
      {can("sensor:manage") && (
        <form className="card" onSubmit={submit} noValidate aria-labelledby="rule-form-heading" style={{ marginTop: "1rem" }}>
          <h3 id="rule-form-heading" style={{ marginTop: 0 }}>
            {t.form.heading}
          </h3>
          <div className="grid-2">
            <SelectField label={t.form.metric} value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)}>
              {RULE_METRICS.map((k) => (
                <option key={k} value={k}>
                  {m.observations.metrics[k]}
                </option>
              ))}
            </SelectField>
            <SelectField label={t.form.comparator} value={comparator} onChange={(e) => setComparator(e.target.value as typeof comparator)}>
              {COMPARATORS.map((c) => (
                <option key={c} value={c}>
                  {t.comparators[c]}
                </option>
              ))}
            </SelectField>
            <TextField label={`${t.form.threshold} (${unitOf(metric)})`} inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} error={error} />
            <TextField label={t.form.consecutive} inputMode="numeric" value={consecutive} onChange={(e) => setConsecutive(e.target.value)} />
            <TextField label={t.form.window} inputMode="numeric" value={windowMinutes} onChange={(e) => setWindowMinutes(e.target.value)} />
            <SelectField label={t.form.severity} value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
              {SEVERITIES.map((x) => (
                <option key={x} value={x}>
                  {t.severities[x]}
                </option>
              ))}
            </SelectField>
          </div>
          <Button type="submit" variant="primary" busy={busy}>
            {t.form.submit}
          </Button>
        </form>
      )}
    </section>
  );
}
