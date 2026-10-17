"use client";
import { useState, type FormEvent } from "react";
import { Button, ErrorSummary, Notice, PageHeader, TextField, useAnnounce } from "@metafarm/ui";
import { api, unwrap } from "@/lib/api";
import { ROLE_LABELS } from "@/lib/roles";
import { useTenant } from "@/lib/tenant";
import Link from "next/link";

export default function AccountPage() {
  const { me, signedIn, reloadMe } = useTenant();
  const announce = useAnnounce();
  const [displayName, setDisplayName] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!signedIn) {
    return (
      <>
        <PageHeader title="Your account" />
        <p>
          <Link href="/sign-in">Sign in</Link> to see your account.
        </p>
      </>
    );
  }
  const name = displayName ?? me?.displayName ?? "";

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors([]);
    setSaved(false);
    try {
      await unwrap(api.PATCH("/v1/me/profile", { body: { displayName: name.trim() || null } }));
      setSaved(true);
      announce("Name saved.");
      reloadMe();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Your account" description="How other members of your workspaces see you." />
      <form className="card" onSubmit={save} noValidate>
        <ErrorSummary errors={errors} />
        <TextField
          label="Display name"
          hint="Shown to people in your workspaces, for example on files you upload. Leave empty to show your email instead."
          value={name}
          maxLength={120}
          autoComplete="name"
          onChange={(e) => {
            setDisplayName(e.target.value);
            setSaved(false);
          }}
        />
        <Button type="submit" variant="primary" busy={busy}>
          Save
        </Button>
        {saved && <p role="status">Saved.</p>}
      </form>
      <section aria-labelledby="memberships-heading" style={{ marginTop: "1.5rem" }}>
        <h2 id="memberships-heading">Your workspaces</h2>
        {me && me.tenants.length > 0 ? (
          <ul>
            {me.tenants.map((t) => (
              <li key={t.tenantId}>
                {t.name} — {ROLE_LABELS[t.role].label}
              </li>
            ))}
          </ul>
        ) : (
          <Notice>You are not in a workspace yet.</Notice>
        )}
        <p>
          <Link href="/workspaces/new">Create another workspace</Link>
        </p>
      </section>
    </>
  );
}
