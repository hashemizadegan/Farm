"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Button, EmptyState, ErrorSummary, Notice, PageHeader, SelectField, StatusPill, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { useI18n } from "@/i18n/provider";
import { API_URL, api, unwrap, useQuery, type Schemas } from "@/lib/api";
import { useCan } from "@/lib/can";

/**
 * Registered integrations (signed external sensor and observation feeds): list, register, rotate and revoke, for
 * members with integration:manage (admins and owners; the API enforces it). A signing secret is shown once, kept only
 * in this component's state (never in storage, the query cache, logs or analytics) and dropped when acknowledged.
 */
type Integration = Schemas["Integration"];
type Kind = Integration["kind"];

const EVENT_TYPES_FOR: Record<Kind, Integration["allowedEventTypes"]> = {
  sensor_feed: ["sensor.readings"],
  observation_feed: ["observation.reported"],
};
const PROVIDER = /^[a-z0-9][a-z0-9-]{1,39}$/;

export default function IntegrationsPage() {
  const t = useI18n().m.integrations;
  return (
    <>
      <PageHeader title={t.title} />
      <p className="mf-hint">{t.intro}</p>
      <RequireTenant>{(tenantId) => <Integrations tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

function Integrations({ tenantId }: { tenantId: string }) {
  const t = useI18n().m.integrations;
  const can = useCan();
  const allowed = can("integration:manage");
  const [version, setVersion] = useState(0);
  const [secret, setSecret] = useState<{ id: string; name: string; value: string }>();
  // Never fetch without the permission: the page explains instead of showing an API refusal.
  const list = useQuery(allowed ? `integrations:${tenantId}:${version}` : null, () => unwrap(api.GET("/v1/tenants/{tenantId}/integrations", { params: { path: { tenantId } } })));
  // Switching workspace drops any secret on screen.
  useEffect(() => setSecret(undefined), [tenantId]);
  const reload = () => setVersion((v) => v + 1);

  if (!allowed) return <Notice>{t.notAllowed}</Notice>;
  const notEnabled = list.error?.body?.error === "integrations_not_enabled";
  const items = list.data?.items ?? [];
  return (
    <>
      {secret && <SecretPanel integrationId={secret.id} name={secret.name} secret={secret.value} onDone={() => setSecret(undefined)} />}
      {list.loading && !list.data && <p role="status">{t.loading}</p>}
      {notEnabled && <Notice tone="warning">{t.notEnabled}</Notice>}
      {list.error && !notEnabled && (
        <Notice tone="error" title={t.couldNotLoad}>
          {list.error.message}
        </Notice>
      )}
      {list.data && items.length === 0 && <EmptyState title={t.none} />}
      {items.length > 0 && (
        <ul className="tasks">
          {items.map((i) => (
            <li key={i.id}>
              <IntegrationCard tenantId={tenantId} integration={i} onChanged={reload} onSecret={(value) => setSecret({ id: i.id, name: i.name, value })} />
            </li>
          ))}
        </ul>
      )}
      {!notEnabled && list.data && (
        <RegisterForm
          tenantId={tenantId}
          onRegistered={(i, value) => {
            setSecret({ id: i.id, name: i.name, value });
            reload();
          }}
        />
      )}
    </>
  );
}

function IntegrationCard({ tenantId, integration: i, onChanged, onSecret }: { tenantId: string; integration: Integration; onChanged: () => void; onSecret: (secret: string) => void }) {
  const { m, fmt } = useI18n();
  const t = m.integrations;
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const path = { tenantId, integrationId: i.id };

  async function act(kind: "rotate" | "revoke") {
    if (!window.confirm(kind === "rotate" ? t.rotateConfirm(i.name) : t.revokeConfirm(i.name))) return;
    setBusy(true);
    setError(undefined);
    try {
      if (kind === "rotate") {
        const r = await unwrap(api.POST("/v1/tenants/{tenantId}/integrations/{integrationId}/rotate", { params: { path } }));
        onSecret(r.secret);
      } else {
        await unwrap(api.POST("/v1/tenants/{tenantId}/integrations/{integrationId}/revoke", { params: { path } }));
        announce(t.revoked(i.name));
      }
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const active = i.status === "active";
  return (
    <article className="task" data-status={active ? "todo" : "cancelled"} aria-labelledby={`integration-${i.id}`}>
      <div className="task__head">
        <h2 id={`integration-${i.id}`} className="task__title">
          {i.name}
        </h2>
        <StatusPill tone={active ? "ok" : "neutral"}>{t.status[i.status]}</StatusPill>
      </div>
      <p className="task__meta">
        {[
          t.kinds[i.kind],
          i.allowedEventTypes.map((e) => t.eventTypes[e]).join(", "),
          t.meta(i.provider, i.secretVersion),
          t.created(fmt.dateTime(i.createdAt)),
          i.lastSeenAt ? t.lastSeen(fmt.dateTime(i.lastSeenAt)) : t.neverSeen,
          i.revokedAt ? t.revokedAt(fmt.dateTime(i.revokedAt)) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {error && (
        <p className="mf-error" role="alert">
          {error}
        </p>
      )}
      {active && (
        <div className="task__actions">
          <Button busy={busy} onClick={() => act("rotate")}>
            {t.rotate}
            <span className="mf-visually-hidden">{t.actionsFor(i.name)}</span>
          </Button>
          <Button variant="danger" busy={busy} onClick={() => act("revoke")}>
            {t.revoke}
            <span className="mf-visually-hidden">{t.actionsFor(i.name)}</span>
          </Button>
        </div>
      )}
    </article>
  );
}

function SecretPanel({ integrationId, name, secret, onDone }: { integrationId: string; name: string; secret: string; onDone: () => void }) {
  const t = useI18n().m.integrations.secret;
  const [copied, setCopied] = useState(false);
  const [stored, setStored] = useState(false);
  return (
    <section className="card token-panel" aria-labelledby="secret-heading" style={{ marginBottom: "1.5rem" }}>
      <h2 id="secret-heading" style={{ marginTop: 0 }}>
        {t.heading(name)}
      </h2>
      <Notice tone="warning">{t.once}</Notice>
      <div className="copy-field">
        <label htmlFor="integration-secret" className="mf-visually-hidden">
          {t.label}
        </label>
        <input id="integration-secret" readOnly value={secret} autoComplete="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
        <Button
          onClick={async () => {
            await navigator.clipboard.writeText(secret).catch(() => undefined);
            setCopied(true);
          }}
        >
          {copied ? t.copied : t.copy}
        </Button>
      </div>
      <details>
        <summary>{t.how}</summary>
        <p className="ltr">{t.howText("x-webhook-signature", `${API_URL}/v1/integrations/${integrationId}/events`)}</p>
      </details>
      <p>
        <label>
          <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} /> {t.acknowledge}
        </label>
      </p>
      <Button variant="primary" disabled={!stored} onClick={onDone}>
        {t.done}
      </Button>
    </section>
  );
}

function RegisterForm({ tenantId, onRegistered }: { tenantId: string; onRegistered: (i: Integration, secret: string) => void }) {
  const t = useI18n().m.integrations;
  const announce = useAnnounce();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [kind, setKind] = useState<Kind>("sensor_feed");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p: { field?: string; message: string }[] = [];
    if (!name.trim()) p.push({ field: "integration-name", message: t.form.nameRequired });
    if (!PROVIDER.test(provider.trim())) p.push({ field: "integration-provider", message: t.form.providerInvalid });
    setErrors(p);
    if (p.length) return;
    setBusy(true);
    try {
      const r = await unwrap(
        api.POST("/v1/tenants/{tenantId}/integrations", {
          params: { path: { tenantId } },
          body: { kind, provider: provider.trim(), name: name.trim(), allowedEventTypes: EVENT_TYPES_FOR[kind] },
        }),
      );
      announce(t.secret.heading(r.integration.name));
      setName("");
      setProvider("");
      onRegistered(r.integration, r.secret);
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  const err = (f: string) => errors.find((x) => x.field === f)?.message;
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="integration-form-heading" style={{ marginTop: "1.5rem" }}>
      <h2 id="integration-form-heading" style={{ marginTop: 0 }}>
        {t.form.heading}
      </h2>
      <ErrorSummary errors={errors} />
      <div className="grid-2">
        <TextField id="integration-name" label={t.form.name} hint={t.form.nameHint} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} error={err("integration-name")} />
        <TextField
          id="integration-provider"
          label={t.form.provider}
          hint={t.form.providerHint}
          value={provider}
          maxLength={40}
          autoCapitalize="none"
          spellCheck={false}
          onChange={(e) => setProvider(e.target.value)}
          error={err("integration-provider")}
        />
        <SelectField label={t.form.kind} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {(Object.keys(EVENT_TYPES_FOR) as Kind[]).map((k) => (
            <option key={k} value={k}>
              {t.kinds[k]}
            </option>
          ))}
        </SelectField>
      </div>
      <Button type="submit" variant="primary" busy={busy}>
        {t.form.submit}
      </Button>
    </form>
  );
}
