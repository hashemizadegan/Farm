"use client";
import { useState, type FormEvent } from "react";
import { Button, ErrorSummary, Notice, PageHeader, SelectField, TextField, useAnnounce } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";
import { ROLE_LABELS, ROLE_ORDER, type Role } from "@/lib/roles";
import { useTenant } from "@/lib/tenant";

export default function TeamPage() {
  return (
    <>
      <PageHeader title="Team" description="People in this workspace and what each of them can do." />
      <RequireTenant>{(tenantId) => <Team tenantId={tenantId} />}</RequireTenant>
    </>
  );
}

function Team({ tenantId }: { tenantId: string }) {
  const can = useCan();
  const manage = can("member:manage");
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
        <summary>What each role can do</summary>
        <dl>
          {ROLE_ORDER.map((r) => (
            <div key={r}>
              <dt>{ROLE_LABELS[r].label}</dt>
              <dd>{ROLE_LABELS[r].summary}</dd>
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
  const myRole = me?.tenants.find((t) => t.tenantId === current)?.role;
  const members = useQuery(`members:${tenantId}`, () => unwrap(api.GET("/v1/tenants/{tenantId}/members", { params: { path: { tenantId } } })));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  async function changeRole(userId: string, role: Role, name: string) {
    setBusy(userId);
    setError(undefined);
    try {
      await unwrap(api.PATCH("/v1/tenants/{tenantId}/members/{userId}", { params: { path: { tenantId, userId } }, body: { role } }));
      announce(`${name} is now ${ROLE_LABELS[role].label}.`);
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
    const question = self ? "Leave this workspace? You will lose access to its farms." : `Remove ${name} from this workspace?`;
    if (!window.confirm(question)) return;
    setBusy(userId);
    setError(undefined);
    try {
      await unwrap(api.DELETE("/v1/tenants/{tenantId}/members/{userId}", { params: { path: { tenantId, userId } } }));
      announce(self ? "You left the workspace." : `${name} removed.`);
      if (self) reloadMe();
      else members.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  if (members.loading && !members.data) return <p role="status">Loading members…</p>;
  if (members.error) return <Notice tone="error" title="Could not load members.">{members.error.message}</Notice>;
  const items = members.data?.items ?? [];

  return (
    <section aria-labelledby="members-heading">
      <h2 id="members-heading">Members ({items.length})</h2>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Joined</th>
              <th scope="col">
                <span className="mf-visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => {
              const self = m.userId === me?.userId;
              const name = m.displayName || m.email || "Unnamed member";
              // Only owners may change or grant the owner role; the API enforces this too.
              const editable = manage && !self && (m.role !== "owner" || myRole === "owner");
              return (
                <tr key={m.userId}>
                  <td>
                    {name}
                    {self && " (you)"}
                    {m.email && m.displayName && (
                      <>
                        <br />
                        <span className="mf-hint">{m.email}</span>
                      </>
                    )}
                  </td>
                  <td>
                    {editable ? (
                      <>
                        <label htmlFor={`role-${m.userId}`} className="mf-visually-hidden">
                          Role for {name}
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
                              {ROLE_LABELS[r].label}
                            </option>
                          ))}
                        </select>
                      </>
                    ) : (
                      ROLE_LABELS[m.role].label
                    )}
                  </td>
                  <td>
                    <time dateTime={m.joinedAt}>{new Date(m.joinedAt).toLocaleDateString()}</time>
                  </td>
                  <td>
                    {(editable || self) && (
                      <Button variant={self ? "secondary" : "danger"} busy={busy === m.userId} onClick={() => remove(m.userId, name, self)}>
                        {self ? "Leave" : "Remove"}
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
      setErrors([{ field: "invite-email", message: "Enter the email address of the person you are inviting." }]);
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
      announce("Invitation link created. Copy it and send it to the person.");
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
      announce("Link copied.");
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="card" aria-labelledby="invite-heading" style={{ marginTop: "1.5rem" }}>
      <h2 id="invite-heading">Invite someone</h2>
      <p className="mf-hint">
        This creates a single-use link valid for 7 days. Nothing is emailed: send the link yourself. Whoever opens it and
        signs in joins with the role you choose, so share it only with that person.
      </p>
      <ErrorSummary errors={errors} />
      <form onSubmit={submit} noValidate>
        <TextField
          id="invite-email"
          label="Their email address"
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.find((x) => x.field === "invite-email")?.message}
        />
        <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} hint={ROLE_LABELS[role].summary}>
          {ROLE_ORDER.filter((r) => r !== "owner" || myRole === "owner").map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r].label}
            </option>
          ))}
        </SelectField>
        <Button type="submit" variant="primary" busy={busy}>
          Create invitation link
        </Button>
      </form>
      {link && (
        <div style={{ marginTop: "1rem" }}>
          <p>
            <strong>Link for {link.email}</strong> — shown only now. Expires {new Date(link.expiresAt).toLocaleString()}.
          </p>
          <div className="copy-field">
            <label htmlFor="invite-link" className="mf-visually-hidden">
              Invitation link
            </label>
            <input id="invite-link" readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
            <Button onClick={copy}>{copied ? "Copied" : "Copy link"}</Button>
          </div>
        </div>
      )}
    </section>
  );
}

function PendingInvitations({ tenantId, reloadKey }: { tenantId: string; reloadKey: number }) {
  const announce = useAnnounce();
  const invites = useQuery(`invites:${tenantId}:${reloadKey}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/invitations", { params: { path: { tenantId } } })),
  );
  const [busy, setBusy] = useState<string>();

  async function revoke(id: string, email: string) {
    setBusy(id);
    try {
      await unwrap(api.DELETE("/v1/tenants/{tenantId}/invitations/{invitationId}", { params: { path: { tenantId, invitationId: id } } }));
      announce(`Invitation for ${email} revoked.`);
      invites.reload();
    } finally {
      setBusy(undefined);
    }
  }

  const items = invites.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="pending-heading" style={{ marginTop: "1.5rem" }}>
      <h2 id="pending-heading">Pending invitations</h2>
      <ul className="files">
        {items.map((i) => (
          <li key={i.id}>
            <span>
              <strong>{i.email}</strong> as {ROLE_LABELS[i.role as Role]?.label ?? i.role}
              <br />
              <span className="mf-hint">
                {i.invitedBy ? `Invited by ${i.invitedBy}. ` : ""}Expires {new Date(i.expiresAt).toLocaleString()}.
              </span>
            </span>
            <Button busy={busy === i.id} onClick={() => revoke(i.id, i.email)}>
              Revoke<span className="mf-visually-hidden"> invitation for {i.email}</span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
