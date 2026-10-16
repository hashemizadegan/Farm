"use client";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Button, Notice, SelectField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";

type Status = "open" | "acknowledged" | "resolved" | "";

export default function AlertsPage() {
  const { farmId } = useParams<{ farmId: string }>();
  return (
    <>
      <h1>Alerts</h1>
      <p className="mf-muted">Alerts are raised from recorded observations and your alert rules. Severity is shown in words as well as by position.</p>
      <RequireTenant>{(tenantId) => <Alerts tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}

function Alerts({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const announce = useAnnounce();
  const [status, setStatus] = useState<Status>("open");
  const alerts = useQuery(
    `alerts:${farmId}:${status}`,
    () => unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/alerts", { params: { path: { tenantId, farmId }, query: status ? { status } : {} } })),
    { pollMs: 15_000 },
  );

  const ack = async (alertId: string) => {
    try {
      await unwrap(api.POST("/v1/tenants/{tenantId}/farms/{farmId}/alerts/{alertId}/ack", { params: { path: { tenantId, farmId, alertId } }, body: {} }));
      announce("Alert acknowledged.");
      alerts.reload();
    } catch (err) {
      announce(`Could not acknowledge: ${(err as Error).message}`, "assertive");
    }
  };

  return (
    <>
      <SelectField label="Show" value={status} onChange={(e) => setStatus(e.target.value as Status)}>
        <option value="open">Open alerts</option>
        <option value="acknowledged">Acknowledged</option>
        <option value="resolved">Resolved</option>
        <option value="">All</option>
      </SelectField>
      {alerts.error && <Notice tone="error">{alerts.error.message}</Notice>}
      {alerts.data?.items.length === 0 && <p>No alerts.</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {alerts.data?.items.map((a) => (
          <li key={a.id} className="card" style={{ marginBottom: "0.75rem" }}>
            <p>
              <strong>{a.severity.toUpperCase()}</strong> — {a.message}
            </p>
            <p className="mf-muted">
              Raised <time dateTime={a.createdAt}>{new Date(a.createdAt).toLocaleString()}</time> from {a.evidenceObservationIds.length} observation(s). Status:{" "}
              {a.status}.
            </p>
            {a.status === "open" && <Button onClick={() => ack(a.id)}>Acknowledge<span className="mf-visually-hidden"> alert: {a.message}</span></Button>}
          </li>
        ))}
      </ul>
    </>
  );
}
