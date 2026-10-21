"use client";
import { useState, type FormEvent } from "react";
import { Button, ErrorSummary, Notice, PageHeader, TextField, useAnnounce } from "@metafarm/ui";
import { api, unwrap } from "@/lib/api";
import { useTenant } from "@/lib/tenant";
import Link from "next/link";
import { useI18n } from "@/i18n/provider";
import { PlayerWallets } from "@/components/PlayerWallets";
import { playerWalletsEnabled } from "@/lib/player-wallets";

export default function AccountPage() {
  const { me, signedIn, reloadMe } = useTenant();
  const announce = useAnnounce();
  const { m } = useI18n();
  const t = m.account;
  const [displayName, setDisplayName] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<{ field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!signedIn) {
    return (
      <>
        <PageHeader title={t.title} />
        <p>{t.signInToSee((x) => <Link href="/sign-in">{x}</Link>)}</p>
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
      announce(t.savedAnnounce);
      reloadMe();
    } catch (err) {
      setErrors([{ message: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <form className="card" onSubmit={save} noValidate>
        <ErrorSummary errors={errors} />
        <TextField
          label={t.displayName}
          hint={t.displayNameHint}
          value={name}
          maxLength={120}
          autoComplete="name"
          onChange={(e) => {
            setDisplayName(e.target.value);
            setSaved(false);
          }}
        />
        <Button type="submit" variant="primary" busy={busy}>
          {m.common.save}
        </Button>
        {saved && <p role="status">{m.common.saved}</p>}
      </form>
      <section aria-labelledby="memberships-heading" style={{ marginTop: "1.5rem" }}>
        <h2 id="memberships-heading">{t.workspaces}</h2>
        {me && me.tenants.length > 0 ? (
          <ul>
            {me.tenants.map((ws) => (
              <li key={ws.tenantId}>
                {ws.name} — {m.roles[ws.role].label}
              </li>
            ))}
          </ul>
        ) : (
          <Notice>{t.none}</Notice>
        )}
        <p>
          <Link href="/workspaces/new">{t.createAnother}</Link>
        </p>
      </section>
      {playerWalletsEnabled() && <PlayerWallets />}
    </>
  );
}
