"use client";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Button, Notice, SelectField, useAnnounce } from "@metafarm/ui";
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
      <RequireTenant>{(tenantId) => <Alerts tenantId={tenantId} farmId={farmId} />}</RequireTenant>
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
