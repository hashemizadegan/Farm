"use client";
import Link from "next/link";
import { useState } from "react";
import { Notice, ProvenanceBadge, StatusPill } from "@metafarm/ui";
import { RealtimeStatus, pollWhile } from "@/components/RealtimeStatus";
import { useI18n } from "@/i18n/provider";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";
import { useRealtimeUpdates } from "@/lib/realtime";

const EVENTS = ["observation.recorded", "sensor.reading.received"];
const sensorTone = (s: string): "ok" | "pending" | "problem" | "neutral" => (s === "online" ? "ok" : s === "waiting" ? "pending" : s === "silent" ? "problem" : "neutral");

/**
 * A farm's current conditions on its overview: each sensor's freshness (the platform's own rule: reporting, waiting
 * for a first reading, silent past its allowance, or disabled), its latest readings with their times, and the latest
 * observations, each opening its detail. Realtime events and polling refresh the same queries; nothing is computed or
 * filled in here that the API did not report.
 */
export function FarmConditions({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const { m, fmt } = useI18n();
  const t = m.farm.conditions;
  const can = useCan();
  const [tick, setTick] = useState(0);
  const realtime = useRealtimeUpdates({ tenantId, farmId, types: EVENTS }, () => setTick((n) => n + 1));
  const poll = { pollMs: pollWhile(realtime, 30_000) };
  const sensors = useQuery(`conditions-sensors:${farmId}:${tick}`, () => unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/sensors", { params: { path: { tenantId, farmId } } })), poll);
  const observations = useQuery(
    can("observation:read") ? `conditions-obs:${farmId}:${tick}` : null,
    () => unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/observations", { params: { path: { tenantId, farmId }, query: { limit: 5 } } })),
    poll,
  );
  const latest = observations.data?.items ?? [];

  return (
    <section className="card" aria-labelledby="conditions-heading" style={{ marginTop: "1.25rem" }}>
      <h2 id="conditions-heading" style={{ marginTop: 0 }}>
        {t.heading}
      </h2>
      <RealtimeStatus status={realtime} />

      <h3>{t.sensorsHeading}</h3>
      {sensors.loading && !sensors.data && <p role="status">{t.loading}</p>}
      {sensors.error && !sensors.data && <Notice tone="warning">{t.sensorsUnavailable}</Notice>}
      {sensors.data && sensors.data.items.length === 0 && <p>{t.noSensors}</p>}
      {sensors.data && sensors.data.items.length > 0 && (
        <ul className="conditions-sensors">
          {sensors.data.items.map((s) => (
            <li key={s.id}>
              <strong>{s.name}</strong> <StatusPill tone={sensorTone(s.state)}>{m.sensors.states[s.state]}</StatusPill>
              <span className="mf-hint">{s.lastSeenAt ? ` ${m.sensors.lastSeen(fmt.dateTime(s.lastSeenAt))}` : ` ${m.sensors.noReadings}`}</span>
              {s.latest.length > 0 && (
                <ul className="sensor-readings">
                  {s.latest.map((r) => (
                    <li key={r.metric}>
                      <span>{m.observations.metrics[r.metric] ?? r.metric}</span>
                      <strong>
                        {r.value === null ? m.common.none : fmt.number(r.value, { maximumFractionDigits: 2 })} {m.observations.units[r.unit] ?? r.unit}
                      </strong>
                      <time className="mf-hint" dateTime={r.observedAt}>
                        {fmt.dateTime(r.observedAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      <p>
        <Link href={`/farms/${farmId}/sensors`}>{t.manageSensors}</Link>
      </p>

      {can("observation:read") && (
        <>
          <h3>{t.latestHeading}</h3>
          {observations.loading && !observations.data && <p role="status">{t.loading}</p>}
          {observations.error && !observations.data && <Notice tone="warning">{t.observationsUnavailable}</Notice>}
          {observations.data && latest.length === 0 && <p>{t.noObservations}</p>}
          {latest.length > 0 && (
            <>
              <p className="mf-hint">{t.lastObservation(fmt.dateTime(latest[0]!.observedAt))}</p>
              <ul className="conditions-observations">
                {latest.map((o) => {
                  const metric = m.observations.metrics[o.metric] ?? o.metric;
                  const value = o.value !== null ? `${fmt.number(o.value)} ${m.observations.units[o.unit] ?? o.unit}` : (o.text ?? "");
                  return (
                    <li key={o.id}>
                      <Link href={`/farms/${farmId}/observations/${o.id}`}>
                        {metric}: {value}
                      </Link>{" "}
                      <time className="mf-hint" dateTime={o.observedAt}>
                        {fmt.dateTime(o.observedAt)}
                      </time>{" "}
                      <ProvenanceBadge label={o.provenance} />
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <p>
            <Link href={`/farms/${farmId}/observations`}>{t.allObservations}</Link>
            {can("integration:manage") && (
              <>
                {" · "}
                <Link href={`/integrations?farmId=${farmId}`}>{t.integrations}</Link>
              </>
            )}
          </p>
        </>
      )}
    </section>
  );
}
