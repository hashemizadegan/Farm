"use client";
import { useState, type FormEvent } from "react";
import { Button, ErrorSummary, Notice, PageHeader, SelectField, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";
import { ROLE_ORDER, type Role } from "@/lib/roles";
import { useTenant } from "@/lib/tenant";
import { useI18n } from "@/i18n/provider";

export default function TeamPage() {
  const t = useI18n().m.team;
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <RequireTenant>{(tenantId) => <Team tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

function Team({ tenantId }: { tenantId: string }) {
  const can = useCan();
  const manage = can("member:manage");
  const { m } = useI18n();
  const [invitesKey, setInvitesKey] = useState(0);
  return (
    <>
      <Members tenantId={tenantId} manage={manage} />
      {manage && (
        <>
          <Invite tenantId={tenantId} onCreated={() => setInvitesKey((k) => k + 1)} />
          <PendingInvitations tenantId={tenantId} reloadKey={invitesKey} />
        </>
      )}
      <details className="card" style={{ marginTop: "1.5rem" }}>
        <summary>{m.team.rolesSummary}</summary>
        <dl>
          {ROLE_ORDER.map((r) => (
            <div key={r}>
              <dt>{m.roles[r].label}</dt>
              <dd>{m.roles[r].summary}</dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}

function Members({ tenantId, manage }: { tenantId: string; manage: boolean }) {
  const { me, tenantId: current, reloadMe } = useTenant();
  const announce = useAnnounce();
  const { m: msgs, fmt } = useI18n();
  const t = msgs.team;
  const myRole = me?.tenants.find((t) => t.tenantId === current)?.role;
  const members = useQuery(`members:${tenantId}`, () => unwrap(api.GET("/v1/tenants/{tenantId}/members", { params: { path: { tenantId } } })));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  async function changeRole(userId: string, role: Role, name: string) {
    setBusy(userId);
    setError(undefined);
    try {
      await unwrap(api.PATCH("/v1/tenants/{tenantId}/members/{userId}", { params: { path: { tenantId, userId } }, body: { role } }));
      announce(t.changed(name, msgs.roles[role].label));
      members.reload();
      if (userId === me?.userId) reloadMe();
    } catch (err) {
      setError((err as Error).message);
      members.reload();
    } finally {
      setBusy(undefined);
    }
  }

  async function remove(userId: string, name: string, self: boolean) {
    const question = self ? t.leaveConfirm : t.removeConfirm(name);
    if (!window.confirm(question)) return;
    setBusy(userId);
    setError(undefined);
    try {
      await unwrap(api.DELETE("/v1/tenants/{tenantId}/members/{userId}", { params: { path: { tenantId, userId } } }));
      announce(self ? t.left : t.removed(name));
      if (self) reloadMe();
      else members.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  if (members.loading && !members.data) return <p role="status">{t.loading}</p>;
  if (members.error) return <Notice tone="error" title={t.couldNotLoad}>{members.error.message}</Notice>;
  const items = members.data?.items ?? [];

  return (
    <section aria-labelledby="members-heading">
      <h2 id="members-heading">{t.members(items.length)}</h2>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">{t.colName}</th>
              <th scope="col">{t.colRole}</th>
              <th scope="col">{t.colJoined}</th>
              <th scope="col">
                <span className="mf-visually-hidden">{t.colActions}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => {
              const self = m.userId === me?.userId;
              const name = m.displayName || m.email || t.unnamed;
              // Only owners may change or grant the owner role; the API enforces this too.
              const editable = manage && !self && (m.role !== "owner" || myRole === "owner");
              return (
                <tr key={m.userId}>
                  <td>
                    {name}
                    {self && t.you}
                    {m.email && m.displayName && (
                      <>
                        <br />
                        <span className="mf-hint ltr">{m.email}</span>
                      </>
                    )}
                  </td>
                  <td>
                    {editable ? (
                      <>
                        <label htmlFor={`role-${m.userId}`} className="mf-visually-hidden">
                          {t.roleFor(name)}
                        </label>
                        <select
                          id={`role-${m.userId}`}
                          className="role-select"
                          value={m.role}
                          disabled={busy === m.userId}
                          onChange={(e) => changeRole(m.userId, e.target.value as Role, name)}
                        >
                          {ROLE_ORDER.filter((r) => r !== "owner" || myRole === "owner").map((r) => (
                            <option key={r} value={r}>
                              {msgs.roles[r].label}
                            </option>
                          ))}
                        </select>
                      </>
                    ) : (
                      msgs.roles[m.role].label
                    )}
                  </td>
                  <td>
                    <time dateTime={m.joinedAt}>{fmt.date(m.joinedAt)}</time>
                  </td>
                  <td>
                    {(editable || self) && (
                      <Button variant={self ? "secondary" : "danger"} busy={busy === m.userId} onClick={() => remove(m.userId, name, self)}>
                        {self ? t.leave : t.remove}
                        {!self && <span className="mf-visually-hidden"> {name}</span>}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Invite({ tenantId, onCreated }: { tenantId: string; onCreated: () => void }) {
  const { me, tenantId: current } = useTenant();
  const announce = useAnnounce();
  const { m, fmt } = useI18n();
  const t = m.team.invite;
  const myRole = me?.tenants.find((t) => t.tenantId === current)?.role;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; email: string; expiresAt: string }>();
  const [copied, setCopied] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setErrors([{ field: "invite-email", message: t.emailRequired }]);
      return;
    }
    setBusy(true);
    setErrors([]);
    setCopied(false);
    try {
      const inv = await unwrap(api.POST("/v1/tenants/{tenantId}/invitations", { params: { path: { tenantId } }, body: { email: email.trim(), role } }));
      // The token travels in the URL fragment, which browsers never send to servers or in Referer headers.
      setLink({ url: `${window.location.origin}/invite#token=${inv.token}`, email: inv.email, expiresAt: inv.expiresAt });
      setEmail("");
      announce(t.created);
      onCreated();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      announce(t.copiedAnnounce);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="card" aria-labelledby="invite-heading" style={{ marginTop: "1.5rem" }}>
      <h2 id="invite-heading">{t.heading}</h2>
      <p className="mf-hint">{t.intro}</p>
      <ErrorSummary errors={errors} />
      <form onSubmit={submit} noValidate>
        <TextField
          id="invite-email"
          label={t.email}
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.find((x) => x.field === "invite-email")?.message}
        />
        <SelectField label={t.role} value={role} onChange={(e) => setRole(e.target.value as Role)} hint={m.roles[role].summary}>
          {ROLE_ORDER.filter((r) => r !== "owner" || myRole === "owner").map((r) => (
            <option key={r} value={r}>
              {m.roles[r].label}
            </option>
          ))}
        </SelectField>
        <Button type="submit" variant="primary" busy={busy}>
          {t.create}
        </Button>
      </form>
      {link && (
        <div style={{ marginTop: "1rem" }}>
          <p>
            <strong>{t.linkFor(link.email)}</strong>
            {t.shownOnce(fmt.dateTime(link.expiresAt))}
          </p>
          <div className="copy-field">
            <label htmlFor="invite-link" className="mf-visually-hidden">
              {t.link}
            </label>
            <input id="invite-link" readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
            <Button onClick={copy}>{copied ? t.copied : t.copy}</Button>
          </div>
        </div>
      )}
    </section>
  );
}

function PendingInvitations({ tenantId, reloadKey }: { tenantId: string; reloadKey: number }) {
  const announce = useAnnounce();
  const { m, fmt } = useI18n();
  const t = m.team.pending;
  const invites = useQuery(`invites:${tenantId}:${reloadKey}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/invitations", { params: { path: { tenantId } } })),
  );
  const [busy, setBusy] = useState<string>();

  async function revoke(id: string, email: string) {
    setBusy(id);
    try {
      await unwrap(api.DELETE("/v1/tenants/{tenantId}/invitations/{invitationId}", { params: { path: { tenantId, invitationId: id } } }));
      announce(t.revoked(email));
      invites.reload();
    } finally {
      setBusy(undefined);
    }
  }

  const items = invites.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="pending-heading" style={{ marginTop: "1.5rem" }}>
      <h2 id="pending-heading">{t.heading}</h2>
      <ul className="files">
        {items.map((i) => (
          <li key={i.id}>
            <span>
              <strong className="ltr">{i.email}</strong>
              {t.as(m.roles[i.role as Role]?.label ?? i.role)}
              <br />
              <span className="mf-hint">
                {i.invitedBy ? t.invitedBy(i.invitedBy) : ""}
                {t.expires(fmt.dateTime(i.expiresAt))}
              </span>
            </span>
            <Button busy={busy === i.id} onClick={() => revoke(i.id, i.email)}>
              {t.revoke}
              <span className="mf-visually-hidden">{t.revokeHidden(i.email)}</span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
