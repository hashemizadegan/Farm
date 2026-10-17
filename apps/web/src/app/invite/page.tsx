"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Notice, PageHeader } from "@metafarm/ui";
import { api, unwrap } from "@/lib/api";
import { rememberReturnTo } from "@/lib/return-to";
import type { Role } from "@/lib/roles";
import { useTenant } from "@/lib/tenant";
import { useI18n } from "@/i18n/provider";

/**
 * Opens an invitation link (/invite#token=…). The token sits in the URL
 * fragment so it never reaches a server log or Referer header. Signed-out
 * visitors are sent to sign in and brought back here afterwards.
 */
export default function InvitePage() {
  const router = useRouter();
  const { signedIn, setTenantId, reloadMe } = useTenant();
  const { m } = useI18n();
  const t = m.invite;
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [error, setError] = useState<string>();
  const [joined, setJoined] = useState<{ name: string; role: Role; alreadyMember: boolean; tenantId: string }>();

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get("token");
    setToken(t && /^[A-Za-z0-9_-]{32,128}$/.test(t) ? t : null);
  }, []);

  useEffect(() => {
    if (token && !signedIn) rememberReturnTo(`/invite#token=${token}`);
  }, [token, signedIn]);

  async function accept() {
    if (!token) return;
    setState("busy");
    setError(undefined);
    try {
      const r = await unwrap(api.POST("/v1/me/invitations/accept", { body: { token } }));
      // Drop the used token from the address bar and history.
      window.history.replaceState(null, "", "/invite");
      setJoined({ name: r.name, role: r.role as Role, alreadyMember: r.alreadyMember, tenantId: r.tenantId });
      setTenantId(r.tenantId);
      reloadMe();
      setState("idle");
    } catch (err) {
      setError((err as Error).message);
      setState("error");
    }
  }

  return (
    <>
      <PageHeader title={t.title} />
      {token === undefined ? (
        <p role="status">{t.reading}</p>
      ) : token === null ? (
        <Notice tone="error" title={t.incompleteTitle}>
          {t.incomplete((x) => <code>{x}</code>)}
        </Notice>
      ) : joined ? (
        <Notice title={joined.alreadyMember ? t.alreadyTitle : t.joinedTitle}>
          {(joined.alreadyMember ? t.already : t.joined)(() => <strong>{joined.name}</strong>, m.roles[joined.role]?.label ?? joined.role)}{" "}
          <Button variant="primary" onClick={() => router.push("/farms")}>
            {t.goToFarms}
          </Button>
        </Notice>
      ) : !signedIn ? (
        <>
          <p>{t.signedOut}</p>
          <Link href="/sign-in" className="mf-button mf-button--primary">
            {t.signInToAccept}
          </Link>
        </>
      ) : (
        <>
          <p>{t.acceptIntro}</p>
          {state === "error" && error && <Notice tone="error" title={t.couldNotAccept}>{error}</Notice>}
          <Button variant="primary" busy={state === "busy"} onClick={accept}>
            {t.accept}
          </Button>
        </>
      )}
    </>
  );
}
