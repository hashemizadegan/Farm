"use client";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { SENSOR_KINDS, type SensorKind } from "@metafarm/domain";
import { Button, EmptyState, ErrorSummary, Notice, SelectField, StatusPill, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { API_URL, api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";

type Sensor = Schemas["Sensor"];

export default function SensorsPage() {
  const { farmId } = useParams<{ farmId: string }>();
  const t = useI18n().m.sensors;
  return (
    <>
      <h1>{t.title}</h1>
      <p className="mf-hint">{t.intro}</p>
      <RequireTenant>{(tenantId) => <Sensors tenantId={tenantId} farmId={farmId} />}</RequireTenant>
    </>
  );
}

const stateTone = (s: string): "ok" | "pending" | "problem" | "neutral" => (s === "online" ? "ok" : s === "waiting" ? "pending" : s === "silent" ? "problem" : "neutral");

function Sensors({ tenantId, farmId }: { tenantId: string; farmId: string }) {
  const t = useI18n().m.sensors;
  const can = useCan();
  const [version, setVersion] = useState(0);
  const [issued, setIssued] = useState<{ name: string; token: string }>();
  const list = useQuery(
    `sensors:${farmId}:${version}`,
    () => unwrap(api.GET("/v1/tenants/{tenantId}/farms/{farmId}/sensors", { params: { path: { tenantId, farmId } } })),
    { pollMs: 30_000 },
  );
  const reload = () => setVersion((v) => v + 1);
  const items = list.data?.items ?? [];

  return (
    <>
      {issued && <TokenPanel name={issued.name} token={issued.token} onDone={() => setIssued(undefined)} />}
      {list.loading && !list.data && <p role="status">{t.loading}</p>}
      {list.error && (
        <Notice tone="error" title={t.couldNotLoad}>
          {list.error.message}
        </Notice>
      )}
      {list.data && items.length === 0 && <EmptyState title={t.none} />}
      {items.length > 0 && (
        <ul className="tasks">
          {items.map((s) => (
            <li key={s.id}>
              <SensorCard tenantId={tenantId} farmId={farmId} s={s} onChanged={reload} onToken={(token) => setIssued({ name: s.name, token })} />
            </li>
          ))}
        </ul>
      )}
      {can("sensor:manage") && (
        <SensorForm
          tenantId={tenantId}
          farmId={farmId}
          onCreated={(name, token) => {
            setIssued({ name, token });
            reload();
          }}
        />
      )}
    </>
  );
}

function SensorCard({ tenantId, farmId, s, onChanged, onToken }: { tenantId: string; farmId: string; s: Sensor; onChanged: () => void; onToken: (t: string) => void }) {
  const { m, fmt } = useI18n();
  const t = m.sensors;
  const can = useCan();
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const path = { tenantId, farmId, sensorId: s.id };

  async function toggle() {
    setBusy(true);
    setError(undefined);
    try {
      const enable = s.status !== "active";
      await unwrap(api.PATCH("/v1/tenants/{tenantId}/farms/{farmId}/sensors/{sensorId}", { params: { path }, body: { status: enable ? "active" : "disabled" } }));
      announce(enable ? t.enabledAnnounce(s.name) : t.disabledAnnounce(s.name));
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    if (!window.confirm(t.rotateConfirm(s.name))) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await unwrap(api.POST("/v1/tenants/{tenantId}/farms/{farmId}/sensors/{sensorId}/rotate", { params: { path } }));
      onToken(r.token);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="task" data-status={s.status === "active" ? "todo" : "cancelled"} aria-labelledby={`sensor-${s.id}`}>
      <div className="task__head">
        <h2 id={`sensor-${s.id}`} className="task__title">
          {s.name}
        </h2>
        <StatusPill tone={stateTone(s.state)}>{t.states[s.state]}</StatusPill>
      </div>
      <p className="task__meta">
        {[t.kinds[s.kind as SensorKind] ?? s.kind, s.parcelLabel, s.lastSeenAt ? t.lastSeen(fmt.dateTime(s.lastSeenAt)) : null, t.silentAfter(s.silentAfterMinutes)]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {s.latest.length === 0 ? (
        <p className="task__notes">{t.noReadings}</p>
      ) : (
        <ul className="sensor-readings">
          {s.latest.map((r) => (
            <li key={r.metric}>
              <span>{m.observations.metrics[r.metric] ?? r.metric}</span>
              <strong>
                {r.value === null ? m.common.none : fmt.number(r.value, { maximumFractionDigits: 2 })} {m.observations.units[r.unit] ?? r.unit}
              </strong>
              <span className="mf-hint">{fmt.dateTime(r.observedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="mf-error" role="alert">
          {error}
        </p>
      )}
      {can("sensor:manage") && (
        <div className="task__actions">
          <Button busy={busy} onClick={rotate}>
            {t.rotate}
            <span className="mf-visually-hidden">{t.actionsFor(s.name)}</span>
          </Button>
          <Button variant={s.status === "active" ? "danger" : "secondary"} busy={busy} onClick={toggle}>
            {s.status === "active" ? t.disable : t.enable}
            <span className="mf-visually-hidden">{t.actionsFor(s.name)}</span>
          </Button>
        </div>
      )}
    </article>
  );
}

function TokenPanel({ name, token, onDone }: { name: string; token: string; onDone: () => void }) {
  const t = useI18n().m.sensors.token;
  const [copied, setCopied] = useState(false);
  const example = `curl -X POST ${API_URL}/v1/ingest/readings \\
  -H "Authorization: Sensor ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"readings":[{"metric":"soil_moisture","value":23.4,"unit":"percent_vwc","observedAt":"${new Date().toISOString().slice(0, 19)}Z"}]}'`;
  return (
    <section className="card token-panel" aria-labelledby="token-heading" style={{ marginBottom: "1.5rem" }}>
      <h2 id="token-heading" style={{ marginTop: 0 }}>
        {t.heading(name)}
      </h2>
      <Notice tone="warning">{t.once}</Notice>
      <div className="copy-field">
        <label htmlFor="sensor-token" className="mf-visually-hidden">
          {t.label}
        </label>
        <input id="sensor-token" readOnly value={token} onFocus={(e) => e.currentTarget.select()} />
        <Button
          onClick={async () => {
            await navigator.clipboard.writeText(token).catch(() => undefined);
            setCopied(true);
          }}
        >
          {copied ? t.copied : t.copy}
        </Button>
      </div>
      <details>
        <summary>{t.example}</summary>
        <pre className="verify__json ltr">{example}</pre>
      </details>
      <Button variant="primary" onClick={onDone}>
        {t.done}
      </Button>
    </section>
  );
}

function SensorForm({ tenantId, farmId, onCreated }: { tenantId: string; farmId: string; onCreated: (name: string, token: string) => void }) {
  const { m } = useI18n();
  const t = m.sensors.form;
  const announce = useAnnounce();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SensorKind>("soil-moisture");
  const [parcel, setParcel] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [silent, setSilent] = useState("180");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p: { field?: string; message: string }[] = [];
    if (!name.trim()) p.push({ field: "sensor-name", message: t.nameRequired });
    const la = lat.trim() === "" ? null : Number(lat);
    const lo = lon.trim() === "" ? null : Number(lon);
    if ((la === null) !== (lo === null) || (la !== null && !(Math.abs(la) <= 90)) || (lo !== null && !(Math.abs(lo) <= 180))) p.push({ field: "sensor-lat", message: t.coordsInvalid });
    const mins = Number(silent);
    if (!(Number.isInteger(mins) && mins >= 5 && mins <= 10_080)) p.push({ field: "sensor-silent", message: t.minutesInvalid });
    setErrors(p);
    if (p.length) return;
    setBusy(true);
    try {
      const r = await unwrap(
        api.POST("/v1/tenants/{tenantId}/farms/{farmId}/sensors", {
          params: { path: { tenantId, farmId } },
          body: { name: name.trim(), kind, parcelLabel: parcel.trim() || null, location: la !== null && lo !== null ? { lat: la, lon: lo } : null, silentAfterMinutes: mins },
        }),
      );
      announce(m.sensors.token.heading(r.sensor.name));
      setName("");
      setParcel("");
      setLat("");
      setLon("");
      onCreated(r.sensor.name, r.token);
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  const err = (f: string) => errors.find((x) => x.field === f)?.message;
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="sensor-form-heading" style={{ marginTop: "1.5rem" }}>
      <h2 id="sensor-form-heading" style={{ marginTop: 0 }}>
        {t.heading}
      </h2>
      <ErrorSummary errors={errors} />
      <div className="grid-2">
        <TextField id="sensor-name" label={t.name} hint={t.nameHint} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} error={err("sensor-name")} />
        <SelectField label={t.kind} value={kind} onChange={(e) => setKind(e.target.value as SensorKind)}>
          {SENSOR_KINDS.map((k) => (
            <option key={k} value={k}>
              {m.sensors.kinds[k]}
            </option>
          ))}
        </SelectField>
        <TextField label={t.parcel} value={parcel} maxLength={80} onChange={(e) => setParcel(e.target.value)} />
        <TextField id="sensor-silent" label={t.silent} inputMode="numeric" value={silent} onChange={(e) => setSilent(e.target.value)} error={err("sensor-silent")} />
        <TextField id="sensor-lat" label={t.lat} inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} error={err("sensor-lat")} />
        <TextField label={t.lon} inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} />
      </div>
      <Button type="submit" variant="primary" busy={busy}>
        {t.submit}
      </Button>
    </form>
  );
}
