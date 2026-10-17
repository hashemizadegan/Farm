"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Notice, PageHeader } from "@metafarm/ui";
import { api, unwrap } from "@/lib/api";
import { rememberReturnTo } from "@/lib/return-to";
import { ROLE_LABELS, type Role } from "@/lib/roles";
import { useTenant } from "@/lib/tenant";

/**
 * Opens an invitation link (/invite#token=…). The token sits in the URL
 * fragment so it never reaches a server log or Referer header. Signed-out
 * visitors are sent to sign in and brought back here afterwards.
 */
export default function InvitePage() {
  const router = useRouter();
  const { signedIn, setTenantId, reloadMe } = useTenant();
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
      <PageHeader title="Join a workspace" />
      {token === undefined ? (
        <p role="status">Reading invitation…</p>
      ) : token === null ? (
        <Notice tone="error" title="This link is incomplete.">
          The invitation link should end with <code>#token=</code> followed by a long code. Copy the whole link again, or
          ask for a new one.
        </Notice>
      ) : joined ? (
        <Notice title={joined.alreadyMember ? "You were already a member." : "You have joined."}>
          {joined.alreadyMember ? "You already belong to" : "You are now a member of"} <strong>{joined.name}</strong> as{" "}
          {ROLE_LABELS[joined.role]?.label ?? joined.role}.{" "}
          <Button variant="primary" onClick={() => router.push("/farms")}>
            Go to farms
          </Button>
        </Notice>
      ) : !signedIn ? (
        <>
          <p>You have been invited to a workspace. Sign in or create an account first; you will come back here to accept.</p>
          <Link href="/sign-in" className="mf-button mf-button--primary">
            Sign in to accept
          </Link>
        </>
      ) : (
        <>
          <p>Accept this invitation to join the workspace with the role chosen by the person who invited you.</p>
          {state === "error" && error && <Notice tone="error" title="Could not accept the invitation.">{error}</Notice>}
          <Button variant="primary" busy={state === "busy"} onClick={accept}>
            Accept invitation
          </Button>
        </>
      )}
    </>
  );
}
