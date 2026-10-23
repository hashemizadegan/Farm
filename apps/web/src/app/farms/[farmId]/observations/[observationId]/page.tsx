"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Notice, ProvenanceBadge, StatusPill } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";

/** One observation: value as stored and as received, when it was observed, received and recorded, and its source. */
export default function ObservationPage() {
  const { farmId, observationId } = useParams<{ farmId: string; observationId: string }>();
  return <RequireTenant>{(tenantId) => <Observation tenantId={tenantId} farmId={farmId} observationId={observationId} />}</RequireTenant>;
}

function Observation({ tenantId, farmId, observationId }: { tenantId: string; farmId: string; observationId: string }) {
  const { m, fmt } = useI18n();
  const t = m.observations.detail;
  const can = useCan();
  const q = useQuery(`observation:${observationId}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/observations/{observationId}", { params: { path: { tenantId, farmId, observationId } } })),
  );
  const back = (
    <p>
      <Link href={`/farms/${farmId}/observations`}>{t.back}</Link>
    </p>
  );
  if (q.loading && !q.data) return <p role="status">{t.loading}</p>;
  if (q.error || !q.data) {
    return (
      <>
        <h1>{t.title}</h1>
        <Notice tone="error" title={t.couldNotLoad}>
          {q.error?.status === 404 ? t.notFound : q.error?.message}
        </Notice>
        {back}
      </>
    );
  }
  const o = q.data;
  const metric = m.observations.metrics[o.metric] ?? o.metric;
  const original = typeof o.originalValue === "number" || typeof o.originalValue === "string" ? String(o.originalValue) : JSON.stringify(o.originalValue);
  const time = (iso: string | null | undefined) => (iso ? <time dateTime={iso}>{fmt.dateTime(iso)}</time> : m.common.none);
  const { source } = o;
  return (
    <>
      <h1>
        {t.title}: {metric}
      </h1>
      {back}
      <div className="card">
        <dl className="facts">
          <div>
            <dt>{t.value}</dt>
            <dd>{o.value !== null ? `${fmt.number(o.value)} ${m.observations.units[o.unit] ?? o.unit}` : o.text}</dd>
          </div>
          <div>
            <dt>{t.original}</dt>
            <dd className="ltr">{`${original} ${o.originalUnit}`}</dd>
          </div>
          <div>
            <dt>{t.observedAt}</dt>
            <dd>{time(o.observedAt)}</dd>
          </div>
          <div>
            <dt>{t.receivedAt}</dt>
            <dd>{time(o.receivedAt)}</dd>
          </div>
          <div>
            <dt>{t.recordedAt}</dt>
            <dd>{time(o.recordedAt)}</dd>
          </div>
          <div>
            <dt>{t.provenance}</dt>
            <dd>
              <ProvenanceBadge label={o.provenance} />
            </dd>
          </div>
          <div>
            <dt>{t.flags}</dt>
            <dd>{o.qualityFlags.length ? fmt.list(o.qualityFlags.map((f) => m.observations.flags[f] ?? f)) : m.common.none}</dd>
          </div>
        </dl>
      </div>

      <section className="card" aria-labelledby="source-heading" style={{ marginTop: "1.25rem" }}>
        <h2 id="source-heading" style={{ marginTop: 0 }}>
          {t.source}: {t.sourceKinds[source.kind]}
        </h2>
        <dl className="facts">
          {source.integration && (
            <>
              <div>
                <dt>{t.integration}</dt>
                <dd>
                  {source.integration.name} <span className="mf-hint ltr">({source.integration.provider})</span>{" "}
                  <StatusPill tone={source.integration.status === "active" ? "ok" : "neutral"}>{m.integrations.status[source.integration.status]}</StatusPill>
                </dd>
              </div>
              <div>
                <dt>{t.providerEvent}</dt>
                <dd className="ltr">
                  <code>{source.integration.providerEventId}</code>
                </dd>
              </div>
            </>
          )}
          {source.sensor && (
            <div>
              <dt>{t.sensor}</dt>
              <dd>
                {source.sensor.name ?? m.common.none} <Link href={`/farms/${farmId}/sensors`}>{t.viewSensor}</Link>
              </dd>
            </div>
          )}
          {source.enteredBy && (
            <div>
              <dt>{t.enteredBy}</dt>
              <dd>{source.enteredBy}</dd>
            </div>
          )}
        </dl>
        {source.integration && can("integration:manage") && (
          <p>
            <Link href={`/integrations?farmId=${farmId}#integration-${source.integration.id}`}>{t.manageIntegration}</Link>
          </p>
        )}
      </section>
    </>
  );
}
