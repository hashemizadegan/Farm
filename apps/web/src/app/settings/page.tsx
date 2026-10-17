"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button, ErrorSummary, Notice, PageHeader, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap } from "@/lib/api";
import { useCan } from "@/lib/can";
import { useTenant } from "@/lib/tenant";
import { useI18n } from "@/i18n/provider";

export default function WorkspaceSettingsPage() {
  const { m } = useI18n();
  return (
    <>
      <PageHeader title={m.wsSettings.title} />
      <RequireTenant>{(tenantId) => <Settings tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

function Settings({ tenantId }: { tenantId: string }) {
  const { me, reloadMe } = useTenant();
  const can = useCan();
  const announce = useAnnounce();
  const { m } = useI18n();
  const t = m.wsSettings;
  const ws = me?.tenants.find((t) => t.tenantId === tenantId);
  const [name, setName] = useState(ws?.name ?? "");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => setName(ws?.name ?? ""), [ws?.name]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setErrors([{ field: "ws-name", message: t.nameRequired }]);
      return;
    }
    setBusy(true);
    setErrors([]);
    setSaved(false);
    try {
      await unwrap(api.PATCH("/v1/tenants/{tenantId}/settings", { params: { path: { tenantId } }, body: { name: name.trim() } }));
      setSaved(true);
      announce(t.saved);
      reloadMe();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  if (!ws) return null;
  return (
    <>
      <section className="card" aria-labelledby="ws-heading">
        <h2 id="ws-heading">{t.general}</h2>
        <dl className="facts">
          <dt>{t.yourRole}</dt>
          <dd>{m.roles[ws.role].label}</dd>
          <dt>{t.id}</dt>
          <dd className="ltr">
            <code>{ws.slug}</code>
          </dd>
        </dl>
        {can("member:manage") ? (
          <form onSubmit={save} noValidate>
            <ErrorSummary errors={errors} />
            <TextField
              id="ws-name"
              label={t.name}
              value={name}
              maxLength={200}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
              error={errors.find((x) => x.field === "ws-name")?.message}
            />
            <Button type="submit" variant="primary" busy={busy}>
              {m.common.save}
            </Button>
            {saved && <p role="status">{m.common.saved}</p>}
          </form>
        ) : (
          <p>{t.readonly(() => <strong>{ws.name}</strong>)}</p>
        )}
      </section>
      <Notice title={t.peopleTitle}>
        {t.people(
          (x) => <Link href="/team">{x}</Link>,
          (x) => <Link href="/account">{x}</Link>,
        )}
      </Notice>
    </>
  );
}
