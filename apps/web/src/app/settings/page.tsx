"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button, ErrorSummary, Notice, PageHeader, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap } from "@/lib/api";
import { useCan } from "@/lib/can";
import { ROLE_LABELS } from "@/lib/roles";
import { useTenant } from "@/lib/tenant";

export default function WorkspaceSettingsPage() {
  return (
    <>
      <PageHeader title="Workspace settings" />
      <RequireTenant>{(tenantId) => <Settings tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

function Settings({ tenantId }: { tenantId: string }) {
  const { me, reloadMe } = useTenant();
  const can = useCan();
  const announce = useAnnounce();
  const ws = me?.tenants.find((t) => t.tenantId === tenantId);
  const [name, setName] = useState(ws?.name ?? "");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => setName(ws?.name ?? ""), [ws?.name]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setErrors([{ field: "ws-name", message: "Enter a workspace name." }]);
      return;
    }
    setBusy(true);
    setErrors([]);
    setSaved(false);
    try {
      await unwrap(api.PATCH("/v1/tenants/{tenantId}/settings", { params: { path: { tenantId } }, body: { name: name.trim() } }));
      setSaved(true);
      announce("Workspace name saved.");
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
        <h2 id="ws-heading">General</h2>
        <dl className="facts">
          <dt>Your role</dt>
          <dd>{ROLE_LABELS[ws.role].label}</dd>
          <dt>Workspace ID</dt>
          <dd>
            <code>{ws.slug}</code>
          </dd>
        </dl>
        {can("member:manage") ? (
          <form onSubmit={save} noValidate>
            <ErrorSummary errors={errors} />
            <TextField
              id="ws-name"
              label="Workspace name"
              value={name}
              maxLength={200}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
              error={errors.find((x) => x.field === "ws-name")?.message}
            />
            <Button type="submit" variant="primary" busy={busy}>
              Save
            </Button>
            {saved && <p role="status">Saved.</p>}
          </form>
        ) : (
          <p>
            Name: <strong>{ws.name}</strong>. Only owners and admins can change workspace settings.
          </p>
        )}
      </section>
      <Notice title="People and access">
        Invite people, change roles or leave this workspace on the <Link href="/team">Team</Link> page. Your own name and
        email are on <Link href="/account">your account</Link>.
      </Notice>
    </>
  );
}
